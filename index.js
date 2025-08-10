require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const bcrypt = require('bcrypt');
const crypto = require('crypto');

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

// 작업자 로그인 엔드포인트 (아이디/비밀번호 방식)
app.post('/worker-login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log('Login attempt:', { username, passwordLength: password?.length });
  
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  
  try {
    // 작업자 계정 조회
    console.log('Searching for worker:', username);
    const { data: worker, error: workerError } = await supabase
      .from('worker_accounts')
      .select(`
        *,
        company:companies(*)
      `)
      .eq('username', username)
      .eq('is_active', true)
      .single();
    
    console.log('Worker search result:', { found: !!worker, error: workerError });
    
    if (workerError || !worker) {
      console.log('Worker not found:', workerError);
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    
    // 비밀번호 확인
    console.log('Checking password...');
    console.log('Password hash from DB:', worker.password_hash);
    const isValidPassword = await bcrypt.compare(password, worker.password_hash);
    console.log('Password valid:', isValidPassword);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    
    // 회사 구독 상태 확인
    if (worker.company.subscription_status !== 'active') {
      return res.status(403).json({ error: '회사 구독이 만료되었습니다. 관리자에게 문의하세요.' });
    }
    
    // 세션 토큰 생성
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8시간
    
    // 기존 세션 삭제
    await supabase
      .from('worker_sessions')
      .delete()
      .eq('worker_id', worker.id);
    
    // 새 세션 저장
    const { error: sessionError } = await supabase
      .from('worker_sessions')
      .insert({
        worker_id: worker.id,
        token: sessionToken,
        expires_at: expiresAt
      });
    
    if (sessionError) {
      console.error('Session creation error:', sessionError);
      return res.status(500).json({ error: '세션 생성 실패' });
    }
    
    // 로그인 시간 업데이트
    await supabase
      .from('worker_accounts')
      .update({ last_login: new Date().toISOString() })
      .eq('id', worker.id);
    
    console.log(`Worker login successful: ${worker.username} from company ${worker.company.name}`);
    
    res.json({
      success: true,
      sessionToken,
      workerInfo: {
        id: worker.id,
        username: worker.username,
        displayName: worker.display_name || worker.username,
        companyId: worker.company_id,
        companyName: worker.company.name
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

// 작업자 인증 미들웨어
async function authenticateWorker(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  
  try {
    // 세션 확인
    const { data: session, error: sessionError } = await supabase
      .from('worker_sessions')
      .select(`
        *,
        worker:worker_accounts(*)
      `)
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .single();
    
    if (sessionError || !session) {
      console.error('Session lookup error:', sessionError);
      return res.status(401).json({ error: '세션이 만료되었거나 유효하지 않습니다.' });
    }
    
    // 활성 상태 확인
    if (!session.worker.is_active) {
      return res.status(403).json({ error: '비활성화된 계정입니다.' });
    }
    
    // 회사 정보 조회
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('*')
      .eq('id', session.worker.company_id)
      .single();
    
    if (companyError || !company) {
      return res.status(500).json({ error: '회사 정보를 찾을 수 없습니다.' });
    }
    
    // 요청 객체에 작업자 정보 추가
    req.worker = session.worker;
    req.company = company;
    
    next();
  } catch (error) {
    console.error('Worker auth error:', error);
    res.status(500).json({ error: '인증 처리 중 오류가 발생했습니다.' });
  }
}


// Presigned URL 발급 엔드포인트 (작업자 인증 사용)
app.post('/get-upload-url', authenticateWorker, async (req, res) => {
  try {
    // Rate limiting 확인 (1분에 60개로 증가)
    if (!checkRateLimit(`worker:${req.worker.id}`, 60, 1)) {
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
    const key = `recordings/${req.company.id}/${req.worker.id}/${timestamp}-${safeFileName}`;
    
    // Presigned URL 생성
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: fileType,
      Metadata: {
        'company-id': req.company.id,
        'worker-id': req.worker.id,
        'uploaded-at': new Date().toISOString()
      }
    });
    
    const uploadUrl = await getSignedUrl(r2Client, command, {
      expiresIn: 3600, // 1시간
    });
    
    // 업로드 로그 기록
    logUpload(req.worker.id, req.worker.username, fileName, fileSize || 0, req.clientIp);
    
    console.log(`Presigned URL generated for worker ${req.worker.username}`);
    
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
app.post('/confirm-upload', authenticateWorker, async (req, res) => {
  try {
    
    const { key, fileSize, duration, barcode, started_at, ended_at } = req.body;
    
    if (!key || !barcode) {
      return res.status(400).json({ error: '필수 필드가 누락되었습니다.' });
    }
    
    // Supabase에 업로드 정보 저장 (packing_records 테이블)
    const { error: insertError } = await supabase.from('packing_records').insert({
      company_id: req.company.id,
      worker_id: req.worker.id,
      order_number: barcode,
      video_url: key,
      video_filename: key.split('/').pop(),
      video_size: fileSize || 0,
      video_duration: duration || 0,
      status: 'completed',
      remux_status: duration && duration <= 1 ? 'skipped' : 'pending',  // 1초 이하는 자동 스킵
      remux_attempts: 0,
      recorded_at: started_at || new Date().toISOString(),
      metadata: {
        started_at: started_at || new Date().toISOString(),
        ended_at: ended_at || new Date().toISOString(),
        uploaded_from: 'worker_app'
      }
    });
    
    if (insertError) {
      console.error('DB insert error:', insertError);
      return res.status(500).json({ error: 'DB 저장 중 오류가 발생했습니다.' });
    }
    
    console.log(`Upload confirmed: ${barcode} by worker ${req.worker.username}`);
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
app.post('/get-video-url', authenticateWorker, async (req, res) => {
  try {
    
    const { key } = req.body;
    
    if (!key) {
      return res.status(400).json({ error: 'key가 필요합니다.' });
    }
    
    // 권한 확인: 같은 회사의 영상인지 확인
    const { data: video, error: dbError } = await supabase
      .from('packing_records')
      .select('company_id, worker_id')
      .eq('video_url', key)
      .single();
    
    if (dbError || !video) {
      return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
    }
    
    // 같은 회사의 영상이 아니면 거부
    if (video.company_id !== req.company.id) {
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
    
    console.log(`Video URL generated for worker ${req.worker.username}, key: ${key}`);
    
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
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Packing server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});