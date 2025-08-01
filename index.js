require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

// 미들웨어
app.use(cors());
app.use(express.json());

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

// 헬스 체크
app.get('/', (req, res) => {
  res.json({ status: 'Packing Server is running!' });
});

// 로그인 엔드포인트
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: '이메일과 비밀번호가 필요합니다.' });
    }
    
    // Supabase 로그인
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    
    if (error) {
      console.error('Login error:', error);
      return res.status(401).json({ error: error.message });
    }
    
    // 성공 시 토큰 반환
    res.json({
      token: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
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
    
    // 요청 본문에서 파일명 추출
    const { fileName, fileType = 'video/webm' } = req.body;
    
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
    
    console.log(`Presigned URL generated for user ${user.email}`);
    
    // Supabase에 업로드 예정 기록 (선택사항)
    try {
      await supabase.from('packings').insert({
        barcode: safeFileName.split('.')[0],
        video_url: `https://your-r2-public-domain/${key}`, // R2 공개 도메인 설정 필요
        video_key: key,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        file_size: 0, // 실제 업로드 후 업데이트 필요
        duration_seconds: 0 // 실제 업로드 후 업데이트 필요
      });
    } catch (dbError) {
      console.error('DB insert error:', dbError);
      // DB 오류가 있어도 URL은 반환
    }
    
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

// 업로드 확인 엔드포인트 (선택사항)
app.post('/confirm-upload', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: '인증이 필요합니다.' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabase.auth.getUser(token);
    
    if (!user) {
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }
    
    const { key, fileSize, duration } = req.body;
    
    // Supabase 업데이트
    await supabase
      .from('packings')
      .update({
        file_size: fileSize,
        duration_seconds: duration
      })
      .eq('video_key', key);
    
    res.json({ message: '업로드가 확인되었습니다.' });
    
  } catch (error) {
    console.error('Confirm upload error:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Packing server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});