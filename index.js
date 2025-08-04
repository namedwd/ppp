require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

// Rate limiting을 위한 메모리 저장소
const requestCounts = new Map();
const uploadLogs = [];

// 미들웨어
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));
app.use(express.json());

// IP 추출 미들웨어
app.use((req, res, next) => {
  req.clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  next();
});

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// R2 클라이언트 초기화
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Rate limiting 함수
function checkRateLimit(userId, limit = parseInt(process.env.RATE_LIMIT_REQUESTS || '10'), windowMinutes = parseInt(process.env.RATE_LIMIT_WINDOW || '1')) {
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const key = `user:${userId}`;
  
  if (!requestCounts.has(key)) {
    requestCounts.set(key, []);
  }
  
  const userRequests = requestCounts.get(key);
  const recentRequests = userRequests.filter(time => now - time < windowMs);
  
  requestCounts.set(key, recentRequests);
  
  if (recentRequests.length >= limit) {
    return false;
  }
  
  recentRequests.push(now);
  return true;
}

// 업로드 로그 기록
function logUpload(userId, email, fileName, fileSize, ip) {
  const log = {
    userId,
    email,
    fileName,
    fileSize,
    ip,
    timestamp: new Date().toISOString()
  };
  
  uploadLogs.push(log);
  
  // 최근 1000개만 유지
  if (uploadLogs.length > 1000) {
    uploadLogs.shift();
  }
  
  console.log('Upload log:', log);
}

// 헬스 체크
app.get('/', (req, res) => {
  res.json({ 
    status: 'Packing Server is running!',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Presigned URL 발급 엔드포인트
app.post('/get-upload-url', async (req, res) => {
  try {
    // Authorization 헤더 확인
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    
    // 토큰 검증
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      console.error('Auth error:', authError);
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }
    
    // Rate limiting 확인 (1분에 60개로 증가)
    if (!checkRateLimit(user.id, 60, 1)) {
      return res.status(429).json({ 
        error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
        retryAfter: 60 
      });
    }
    
    // 요청 본문에서 파일명 추출
    const { fileName, fileType = 'video/webm', fileSize } = req.body;
    
    if (!fileName) {
      return res.status(400).json({ error: 'fileName이 필요합니다.' });
    }
    
    // 파일명 안전성 검사
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const key = `recordings/${user.id}/${timestamp}-${safeFileName}`;
    
    // Presigned URL 생성
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: fileType,
      Metadata: {
        'user-id': user.id,
        'uploaded-at': new Date().toISOString()
      }
    });
    
    const uploadUrl = await getSignedUrl(r2Client, command, {
      expiresIn: 3600, // 1시간
    });
    
    // 업로드 로그 기록
    logUpload(user.id, user.email, fileName, fileSize || 0, req.clientIp);
    
    console.log(`Presigned URL generated for user ${user.email}`);
    
    res.json({
      uploadUrl,
      key,
      expiresIn: 3600,
      message: '업로드 URL이 생성되었습니다.'
    });
    
  } catch (error) {
    console.error('Upload URL generation error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 업로드 확인 엔드포인트
app.post('/confirm-upload', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '인증이 필요합니다.' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }
    
    const { key, fileSize, duration, barcode, started_at, ended_at } = req.body;
    
    if (!key || !barcode) {
      return res.status(400).json({ error: '필수 필드가 누락되었습니다.' });
    }
    
    // Supabase에 업로드 정보 저장
    // 먼저 사용자의 company_id 가져오기
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('company_id')
      .eq('id', user.id)
      .single();
    
    const { error: insertError } = await supabase.from('packings').insert({
      barcode,      
      video_key: key,
      started_at: started_at || new Date().toISOString(),
      ended_at: ended_at || new Date().toISOString(),
      file_size: fileSize || 0,
      duration_seconds: duration || 0,
      user_profile_id: user.id,  // user_id 대신 user_profile_id 사용
      company_id: userProfile?.company_id || null
    });
    
    if (insertError) {
      console.error('DB insert error:', insertError);
      return res.status(500).json({ error: 'DB 저장 중 오류가 발생했습니다.' });
    }
    
    res.json({ message: '업로드가 확인되었습니다.' });
    
  } catch (error) {
    console.error('Confirm upload error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 비디오 조회용 Presigned URL 발급 (GET 방식)
app.get('/api/video-url/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    if (!key) {
      return res.status(400).json({ error: 'key가 필요합니다.' });
    }
    
    // Presigned URL 생성 (1시간 유효)
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    });
    
    const url = await getSignedUrl(r2Client, command, {
      expiresIn: 3600, // 1시간
    });
    
    console.log(`Video URL generated for key: ${key}`);
    
    res.json({
      url,
      expiresIn: 3600
    });
    
  } catch (error) {
    console.error('Get video URL error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 비디오 조회용 Presigned URL 발급 엔드포인트
app.post('/get-video-url', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '인증이 필요합니다.' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }
    
    const { key } = req.body;
    
    if (!key) {
      return res.status(400).json({ error: 'key가 필요합니다.' });
    }
    
    // 권한 확인: 본인 영상인지 또는 관리자인지 확인
    const { data: packing, error: dbError } = await supabase
      .from('packings')
      .select('user_profile_id')  // user_id 대신 user_profile_id
      .eq('video_key', key)
      .single();
    
    if (dbError || !packing) {
      return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    }
    
    // 관리자 권한 확인
    const adminDomains = process.env.ADMIN_EMAIL_DOMAINS ? process.env.ADMIN_EMAIL_DOMAINS.split(',') : [];
    const userDomain = user.email.split('@')[1];
    const isAdmin = adminDomains.length > 0 && adminDomains.includes(userDomain);
    
    // 본인 영상이 아니고 관리자도 아니면 거부
    if (packing.user_profile_id !== user.id && !isAdmin) {  // user_id 대신 user_profile_id
      return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }
    
    // Presigned URL 생성 (1시간 유효)
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    });
    
    const url = await getSignedUrl(r2Client, command, {
      expiresIn: 3600, // 1시간
    });
    
    console.log(`Video URL generated for user ${user.email}, key: ${key}`);
    
    res.json({
      url,
      expiresIn: 3600,
      message: '비디오 URL이 생성되었습니다.'
    });
    
  } catch (error) {
    console.error('Get video URL error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 비디오 조회용 Presigned URL 발급 (인증 없는 버전)
app.post('/get-video-url-noauth', async (req, res) => {
  try {
    const { key } = req.body;
    
    if (!key) {
      return res.status(400).json({ error: 'key가 필요합니다.' });
    }
    
    // 인증 없이 바로 Presigned URL 생성
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    });
    
    const url = await getSignedUrl(r2Client, command, {
      expiresIn: 3600, // 1시간
    });
    
    console.log(`Video URL generated (no auth) for key: ${key}`);
    
    res.json({
      url,
      expiresIn: 3600,
      message: '비디오 URL이 생성되었습니다.'
    });
    
  } catch (error) {
    console.error('Get video URL error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 업로드 로그 조회 엔드포인트 (관리자용)
app.get('/admin/upload-logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '인증이 필요합니다.' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }
    
    // 관리자 권한 확인 (예: 특정 이메일 도메인 확인)
    const adminDomains = process.env.ADMIN_EMAIL_DOMAINS ? process.env.ADMIN_EMAIL_DOMAINS.split(',') : [];
    const userDomain = user.email.split('@')[1];
    
    if (adminDomains.length > 0 && !adminDomains.includes(userDomain)) {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    
    // 최근 업로드 로그 반환
    res.json({
      logs: uploadLogs.slice(-100), // 최근 100개
      total: uploadLogs.length
    });
    
  } catch (error) {
    console.error('Get upload logs error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Packing server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});