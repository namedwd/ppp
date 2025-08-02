# Packing Server - AWS Lightsail 배포 가이드

## 개요
이 서버는 포장 녹화 시스템의 중간서버로, Cloudflare R2에 비디오 업로드를 위한 presigned URL을 발급합니다.

## 주요 기능
- Supabase 토큰 검증 (로그인은 클라이언트에서 직접)
- R2 presigned URL 발급
- Rate limiting (1분에 10개 요청 제한)
- 업로드 로그 기록
- 파일 크기 무제한
- 다중 화질 선택 (SD 480p, HD 720p, Full HD 1080p)

## AWS Lightsail 배포 가이드

### 1. Lightsail 인스턴스 생성
1. AWS Lightsail 콘솔에 로그인
2. "인스턴스 생성" 클릭
3. 다음 설정 선택:
   - 플랫폼: Linux/Unix
   - 블루프린트: Node.js
   - 인스턴스 플랜: 최소 512MB RAM (권장: 1GB)
   - 인스턴스 이름: `packing-server`

### 2. 서버 접속 및 초기 설정
```bash
# SSH로 서버 접속
ssh -i your-key.pem ubuntu@your-lightsail-ip

# Node.js 버전 확인 및 업데이트
node --version
npm --version

# PM2 설치 (프로세스 관리자)
sudo npm install -g pm2

# Git 설치 (필요한 경우)
sudo apt update
sudo apt install git
```

### 3. 애플리케이션 배포
```bash
# 홈 디렉토리로 이동
cd ~

# 프로젝트 디렉토리 생성
mkdir packing-server
cd packing-server

# 파일 업로드 (SCP 사용)
# 로컬에서 실행:
scp -i your-key.pem -r ./* ubuntu@your-lightsail-ip:~/packing-server/

# 또는 Git 사용
git clone your-repo-url .
```

### 4. 환경 설정
```bash
# .env 파일 생성
nano .env

# 다음 내용 입력 (실제 값으로 변경):
```
```
# Server Configuration
PORT=3000
NODE_ENV=production

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key

# R2 Configuration
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=your-bucket-name
R2_PUBLIC_DOMAIN=your-bucket.r2.dev

# Security Configuration
ALLOWED_ORIGINS=https://your-app-domain.com
ADMIN_EMAIL_DOMAINS=yourdomain.com
```

### 5. 의존성 설치 및 실행
```bash
# 의존성 설치
npm install

# PM2로 서버 실행
pm2 start index.js --name packing-server

# PM2 시작 스크립트 저장
pm2 save
pm2 startup
```

### 6. 방화벽 설정
Lightsail 콘솔에서:
1. 인스턴스 클릭
2. "네트워킹" 탭
3. "방화벽" 섹션에서 규칙 추가:
   - 애플리케이션: 사용자 지정
   - 프로토콜: TCP
   - 포트: 3000

### 7. 도메인 연결 (선택사항)
1. Lightsail에서 고정 IP 생성 및 연결
2. DNS 설정에서 A 레코드 추가
3. Nginx 설치 및 리버스 프록시 설정:

```bash
# Nginx 설치
sudo apt install nginx

# 설정 파일 생성
sudo nano /etc/nginx/sites-available/packing-server

# 다음 내용 추가:
```
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# 설정 활성화
sudo ln -s /etc/nginx/sites-available/packing-server /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 8. HTTPS 설정 (권장)
```bash
# Certbot 설치
sudo apt install certbot python3-certbot-nginx

# SSL 인증서 발급
sudo certbot --nginx -d your-domain.com
```

### 9. 모니터링
```bash
# PM2 로그 확인
pm2 logs packing-server

# PM2 모니터링
pm2 monit

# 서버 상태 확인
pm2 status
```

## 소프트웨어 설정

### 1. Tauri 앱 의존성 설치
```bash
cd tauri-app
npm install
```

### 2. 환경변수 설정 (.env 파일)
```env
# Supabase Configuration
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here

# Server Configuration  
VITE_SERVER_URL=https://your-lightsail-server.com
```

### 3. Supabase Anon Key 받기
1. Supabase 대시보드 접속
2. Settings > API
3. `anon` `public` 키 복사 (안전하게 공개 가능)

## 문제 해결

### 서버가 시작되지 않는 경우
```bash
# 로그 확인
pm2 logs packing-server --lines 50

# 포트 사용 확인
sudo netstat -tlnp | grep 3000
```

### CORS 오류 발생 시
`.env` 파일의 `ALLOWED_ORIGINS`에 클라이언트 도메인 추가

### 업로드 실패 시
1. R2 버킷 권한 확인
2. R2 API 키 유효성 확인
3. 서버 로그에서 오류 메시지 확인

## 보안 권장사항
1. 정기적인 보안 업데이트 적용
2. 강력한 SSH 키 사용
3. 환경변수는 절대 Git에 커밋하지 않기
4. Rate limiting 값 조정 (필요시)
5. 관리자 이메일 도메인 설정
