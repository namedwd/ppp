require('dotenv').config();
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

class VideoProcessor {
  constructor() {
    // Supabase 클라이언트
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    
    // R2 클라이언트
    this.r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    
    // 통계
    this.stats = {
      processed: 0,
      failed: 0,
      skipped: 0,
      totalSaved: 0,
      startTime: new Date()
    };

    // 임시 디렉토리 설정
    this.tempDir = path.join(os.tmpdir(), 'video-processor');
  }

  async init() {
    // 임시 디렉토리 생성
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      console.log(`📁 Temp directory ready: ${this.tempDir}`);
    } catch (error) {
      console.error('❌ Failed to create temp directory:', error.message);
    }

    // FFmpeg 확인
    try {
      const { stdout } = await execAsync('ffmpeg -version');
      const version = stdout.split('\n')[0];
      console.log(`✅ FFmpeg detected: ${version}`);
    } catch (error) {
      console.error('⚠️  FFmpeg not found! Please install FFmpeg on the server.');
      console.log('   Ubuntu/Debian: sudo apt-get install ffmpeg');
      console.log('   CentOS/RHEL: sudo yum install ffmpeg');
      console.log('   Amazon Linux: sudo yum install ffmpeg');
    }
  }

  async start() {
    console.log('========================================');
    console.log('📹 Video Processor Service Started');
    console.log(`⏰ Time: ${new Date().toISOString()}`);
    console.log('🔄 Checking every minute for new videos');
    console.log('⚠️  Skipping videos under 1 second');
    console.log('========================================\n');
    
    await this.init();

    // 1분마다 실행
    cron.schedule('* * * * *', () => {
      this.processVideos();
    });
    
    // 시작 시 한 번 실행
    this.processVideos();
    
    // 통계 출력 (10분마다)
    cron.schedule('*/10 * * * *', () => {
      this.printStats();
    });
  }

  async processVideos() {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 🔍 Checking for videos to process...`);
    
    try {
      // 처리 대상 조회 - remux_status 컬럼 활용
      const { data: videos, error } = await this.supabase
        .from('packing_records')
        .select('*')
        .eq('status', 'completed')  // 업로드 완료
        .eq('remux_status', 'pending')  // 리먹싱 대기
        .lt('remux_attempts', 3)  // 3회 미만 시도
        .gt('video_duration', 1)  // 1초 초과
        .order('created_at', { ascending: true })
        .limit(5);

      if (error) {
        console.error('❌ Database query error:', error.message);
        return;
      }

      if (!videos || videos.length === 0) {
        console.log('✅ No videos found');
        return;
      }

      console.log(`📦 Found ${videos.length} video(s) to process`);

      // 병렬 처리 (최대 3개)
      const batchSize = 3;
      for (let i = 0; i < videos.length; i += batchSize) {
        const batch = videos.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(video => this.processVideo(video)));
      }
      
    } catch (error) {
      console.error('❌ Process error:', error.message);
    }
  }

  async processVideo(video) {
    const metadata = video.metadata || {};
    const attemptNumber = (video.remux_attempts || 0) + 1;
    
    console.log(`\n  📹 Processing: ${video.video_filename || video.video_url}`);
    console.log(`     Order: ${video.order_number || 'N/A'} | Size: ${this.formatBytes(video.video_size)} | Duration: ${video.video_duration}s`);
    console.log(`     Attempt: ${attemptNumber}/3`);
    
    // 1초 이하 영상 체크 (추가 안전장치)
    if (video.video_duration && video.video_duration <= 1) {
      console.log(`     ⏭️  Skipping: Video too short (${video.video_duration}s)`);
      this.stats.skipped++;
      
      // 상태를 skipped로 변경
      await this.supabase
        .from('packing_records')
        .update({ 
          remux_status: 'skipped',
          metadata: {
            ...metadata,
            skip_reason: 'duration_too_short',
            skipped_at: new Date().toISOString()
          }
        })
        .eq('id', video.id);
      
      return;
    }

    // 상태를 processing으로 변경하고 시도 횟수 증가
    await this.supabase
      .from('packing_records')
      .update({ 
        remux_status: 'processing',
        remux_attempts: attemptNumber,
        metadata: {
          ...metadata,
          last_remux_attempt: new Date().toISOString()
        }
      })
      .eq('id', video.id);

    const tempInput = path.join(this.tempDir, `input_${video.id}.webm`);
    const tempOutput = path.join(this.tempDir, `output_${video.id}.webm`);

    try {
      // R2 파일 확인
      console.log('     🔍 Checking R2 file...');
      const exists = await this.checkR2File(video.video_url);
      
      if (!exists) {
        console.log(`     ⏳ File not found in R2 (will retry later)`);
        
        if (attemptNumber >= 3) {
          console.log(`     ❌ Giving up after 3 attempts`);
          await this.markAsFailed(video.id, metadata, 'File not found after 3 attempts');
        }
        return;
      }

      console.log('     ✅ File found in R2');
      
      const startTime = Date.now();
      
      // 다운로드
      console.log('     📥 Downloading from R2...');
      await this.downloadFromR2(video.video_url, tempInput);
      
      // 파일 크기 확인
      const inputStats = await fs.stat(tempInput);
      console.log(`     📊 Original size: ${this.formatBytes(inputStats.size)}`);
      
      // 비디오 정보 추출 (duration이 없는 경우를 위해)
      let actualDuration = video.video_duration;
      if (!actualDuration) {
        actualDuration = await this.getVideoDuration(tempInput);
        console.log(`     ⏱️  Detected duration: ${actualDuration}s`);
        
        // 1초 이하면 스킵
        if (actualDuration <= 1) {
          console.log(`     ⏭️  Skipping: Video too short (${actualDuration}s)`);
          this.stats.skipped++;
          
          await this.supabase
            .from('packing_records')
            .update({ 
              remux_status: 'skipped',
              metadata: {
                ...metadata,
                skip_reason: 'duration_too_short',
                detected_duration: actualDuration,
                skipped_at: new Date().toISOString()
              }
            })
            .eq('id', video.id);
          
          await this.cleanup(tempInput, tempOutput);
          return;
        }
      }
      
      // FFmpeg 리먹싱 (WebM 최적화)
      console.log('     🔄 Remuxing with FFmpeg (WebM optimization)...');
      await this.executeFFmpeg(tempInput, tempOutput);
      
      // 출력 파일 확인
      const outputStats = await fs.stat(tempOutput);
      const savedBytes = inputStats.size - outputStats.size;
      const savedPercent = ((savedBytes / inputStats.size) * 100).toFixed(2);
      
      console.log(`     📉 New size: ${this.formatBytes(outputStats.size)}`);
      console.log(`     💾 Saved: ${this.formatBytes(Math.abs(savedBytes))} (${Math.abs(savedPercent)}%)`);
      
      // 크기가 증가한 경우도 업로드 (시킹 개선이 목적이므로)
      if (savedBytes < 0) {
        console.log(`     ℹ️  Size increased but seeking will be improved`);
      }
      
      // R2에 업로드 (덮어쓰기)
      console.log('     📤 Uploading optimized video to R2...');
      await this.uploadToR2(tempOutput, video.video_url);
      
      // DB 업데이트 - 상태를 completed로 변경
      const processingTime = Date.now() - startTime;
      await this.supabase
        .from('packing_records')
        .update({ 
          remux_status: 'completed',
          remuxed_at: new Date().toISOString(),
          remuxed_size: outputStats.size,
          metadata: {
            ...metadata,
            remux_processing_time_ms: processingTime,
            original_size: inputStats.size,
            size_saved: savedBytes,
            compression_ratio: savedPercent,
            detected_duration: actualDuration
          }
        })
        .eq('id', video.id);

      // 통계 업데이트
      this.stats.processed++;
      this.stats.totalSaved += savedBytes;
      
      console.log(`     ✅ Success! Processed in ${(processingTime / 1000).toFixed(2)}s`);
      
    } catch (error) {
      console.error(`     ❌ Failed: ${error.message}`);
      this.stats.failed++;
      
      if (attemptNumber >= 3) {
        await this.markAsFailed(video.id, metadata, error.message);
      }
    } finally {
      // 임시 파일 정리
      await this.cleanup(tempInput, tempOutput);
    }
  }

  async getVideoDuration(filePath) {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );
      return parseFloat(stdout.trim()) || 0;
    } catch (error) {
      console.warn('     ⚠️  Could not detect duration:', error.message);
      return 0;
    }
  }

  async checkR2File(key) {
    try {
      const command = new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key
      });
      
      const response = await this.r2Client.send(command);
      return response.ContentLength > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadFromR2(key, outputPath) {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    });
    
    // 스트림으로 직접 다운로드
    try {
      const response = await this.r2Client.send(command);
      const stream = response.Body;
      
      // Node.js 스트림으로 파일 저장
      const { pipeline } = require('stream');
      const { promisify } = require('util');
      const pipelineAsync = promisify(pipeline);
      const fsStream = require('fs');
      
      await pipelineAsync(
        stream,
        fsStream.createWriteStream(outputPath)
      );
    } catch (error) {
      // 대체 방법: signed URL 사용
      console.log('     📥 Using signed URL for download...');
      const url = await getSignedUrl(this.r2Client, command, { expiresIn: 3600 });
      
      // wget 또는 curl 사용
      try {
        await execAsync(`wget -q -O "${outputPath}" "${url}"`);
      } catch (wgetError) {
        // wget 실패 시 curl 시도
        await execAsync(`curl -s -o "${outputPath}" "${url}"`);
      }
    }
  }

  async uploadToR2(filePath, key) {
    const fileContent = await fs.readFile(filePath);
    
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: fileContent,
      ContentType: 'video/webm',
      Metadata: {
        'remuxed': 'true',
        'remuxed-at': new Date().toISOString(),
        'processor': 'zeropacking-video-processor'
      }
    });
    
    await this.r2Client.send(command);
  }

  async executeFFmpeg(input, output) {
    return new Promise((resolve, reject) => {
      // WebM 최적화 명령어
      // - cluster_size_limit: 클러스터 크기 제한 (시킹 성능 향상)
      // - cluster_time_limit: 클러스터 시간 제한 (밀리초, 5.1초)
      // - cues_to_front: Cues를 파일 앞쪽에 배치 (빠른 시킹)
      // - enable_cues: Cues 활성화
      // - reservation_size: 예약 공간 설정
      const command = [
        'ffmpeg',
        '-i', `"${input}"`,
        '-c copy',                          // 코덱 복사 (리인코딩 없음)
        '-cluster_size_limit', '2M',       // 2MB 클러스터 크기 제한
        '-cluster_time_limit', '5100',     // 5.1초마다 클러스터
        '-metadata:s:v:0', 'cues=1',       // Cues 메타데이터 활성화
        '-reserve_index_space', '200k',    // 인덱스 공간 예약
        '-f', 'webm',                       // WebM 포맷 강제
        `"${output}"`,
        '-y',                               // 덮어쓰기
        '2>&1'                              // 에러 출력 포함
      ].join(' ');
      
      console.log('     📝 FFmpeg command:', command.replace(/"/g, ''));
      
      exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          // FFmpeg는 warning도 stderr로 출력하므로, 실제 에러인지 확인
          if (error.code !== 0 && !stdout.includes('muxing overhead')) {
            const errorMessage = stderr || stdout || error.message;
            reject(new Error(`FFmpeg failed: ${errorMessage.substring(0, 500)}`));
          } else {
            // Warning은 무시하고 성공 처리
            resolve();
          }
        } else {
          resolve();
        }
      });
    });
  }

  async markAsFailed(videoId, existingMetadata, reason) {
    await this.supabase
      .from('packing_records')
      .update({ 
        remux_status: 'failed',
        remux_attempts: 3,
        metadata: {
          ...existingMetadata,
          remux_error: reason,
          failed_at: new Date().toISOString()
        }
      })
      .eq('id', videoId);
  }

  async cleanup(...files) {
    for (const file of files) {
      try {
        await fs.unlink(file);
      } catch (error) {
        // 파일이 없거나 이미 삭제된 경우 무시
      }
    }
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  printStats() {
    const runtime = Math.floor((Date.now() - this.stats.startTime) / 1000 / 60);
    console.log('\n========================================');
    console.log('📊 Video Processor Statistics');
    console.log(`⏱️  Runtime: ${runtime} minutes`);
    console.log(`✅ Processed: ${this.stats.processed} videos`);
    console.log(`⏭️  Skipped: ${this.stats.skipped} videos (too short)`);
    console.log(`❌ Failed: ${this.stats.failed} videos`);
    console.log(`💾 Total saved: ${this.formatBytes(Math.abs(this.stats.totalSaved))}`);
    console.log('========================================\n');
  }
}

// 메인 실행
if (require.main === module) {
  const processor = new VideoProcessor();
  processor.start();
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down Video Processor...');
    processor.printStats();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down Video Processor...');
    processor.printStats();
    process.exit(0);
  });
  
  // 처리되지 않은 에러 처리
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    processor.printStats();
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

module.exports = VideoProcessor;