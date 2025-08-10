-- Supabase SQL Editor에서 실행

-- 1. 필요한 컬럼 추가
ALTER TABLE packing_records 
ADD COLUMN IF NOT EXISTS remux_attempts INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS remux_status VARCHAR DEFAULT NULL,
ADD COLUMN IF NOT EXISTS remuxed_size BIGINT;

-- 2. 인덱스 추가 (성능 향상)
CREATE INDEX IF NOT EXISTS idx_packing_records_remux_status 
ON packing_records(remux_status) 
WHERE remux_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_packing_records_remuxed_url 
ON packing_records(remuxed_url) 
WHERE remuxed_url IS NULL;

-- 3. 통계 뷰 생성 (선택사항)
CREATE OR REPLACE VIEW remux_statistics AS
SELECT 
  COUNT(*) FILTER (WHERE remux_status = 'completed') as completed_count,
  COUNT(*) FILTER (WHERE remux_status = 'failed') as failed_count,
  COUNT(*) FILTER (WHERE remuxed_url IS NULL AND status = 'completed') as pending_count,
  SUM(video_size - remuxed_size) FILTER (WHERE remuxed_size IS NOT NULL) as total_bytes_saved,
  AVG((video_size - remuxed_size)::float / video_size * 100) FILTER (WHERE remuxed_size IS NOT NULL) as avg_compression_ratio
FROM packing_records
WHERE created_at > NOW() - INTERVAL '7 days';

-- 4. 확인 쿼리
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'packing_records' 
AND column_name IN ('remux_attempts', 'remux_status', 'remuxed_size');
