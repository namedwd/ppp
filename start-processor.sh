#!/bin/bash

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Video Processor Setup & Start Script  ${NC}"
echo -e "${GREEN}========================================${NC}\n"

# 1. FFmpeg 확인
echo -e "${YELLOW}Checking FFmpeg installation...${NC}"
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${RED}FFmpeg not found. Installing...${NC}"
    sudo apt update
    sudo apt install -y ffmpeg
else
    echo -e "${GREEN}✓ FFmpeg is installed${NC}"
    ffmpeg -version | head -n 1
fi

# 2. Node 패키지 확인
echo -e "\n${YELLOW}Checking Node packages...${NC}"
if [ ! -d "node_modules/node-cron" ]; then
    echo -e "${YELLOW}Installing node-cron...${NC}"
    npm install node-cron
else
    echo -e "${GREEN}✓ node-cron is installed${NC}"
fi

# 3. 임시 폴더 생성
echo -e "\n${YELLOW}Creating temp directory...${NC}"
mkdir -p temp
mkdir -p logs
echo -e "${GREEN}✓ Directories created${NC}"

# 4. 환경 변수 확인
echo -e "\n${YELLOW}Checking environment variables...${NC}"
if [ ! -f .env ]; then
    echo -e "${RED}⚠ .env file not found!${NC}"
    echo "Please create .env file with required variables"
    exit 1
else
    echo -e "${GREEN}✓ .env file found${NC}"
fi

# 5. 실행 옵션 선택
echo -e "\n${YELLOW}How would you like to run the video processor?${NC}"
echo "1) Foreground (see logs directly)"
echo "2) Background with PM2"
echo "3) Test mode (single run)"
read -p "Enter choice (1-3): " choice

case $choice in
    1)
        echo -e "\n${GREEN}Starting Video Processor in foreground...${NC}"
        node video-processor.js
        ;;
    2)
        echo -e "\n${GREEN}Starting Video Processor with PM2...${NC}"
        if ! command -v pm2 &> /dev/null; then
            echo -e "${YELLOW}Installing PM2...${NC}"
            npm install -g pm2
        fi
        pm2 delete video-processor 2>/dev/null
        pm2 start video-processor.js --name video-processor
        pm2 logs video-processor
        ;;
    3)
        echo -e "\n${GREEN}Running test mode...${NC}"
        node -e "
        const VideoProcessor = require('./video-processor.js');
        const processor = new VideoProcessor();
        processor.processVideos().then(() => {
            console.log('Test run completed');
            process.exit(0);
        });
        "
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac
