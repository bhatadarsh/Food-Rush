// Lambda: triggered on S3 ObjectCreated → food-photos/*
// Runtime: nodejs18.x  (uses built-in @aws-sdk/client-s3 & @aws-sdk/client-cloudwatch)

const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
const cw = new CloudWatchClient({ region: process.env.AWS_REGION || 'ap-south-1' });

exports.handler = async (event) => {
  console.log('[FoodApp Lambda] Triggered! Records:', event.Records.length);

  const results = [];

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const size   = record.s3.object.size;

    console.log(`[Lambda] Processing: s3://${bucket}/${key}  (${size} bytes)`);

    try {
      // 1. Read file metadata from S3
      const meta = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const contentType = meta.ContentType || 'unknown';
      const isImage     = contentType.startsWith('image/');

      // 2. Push custom metrics to CloudWatch → FoodApp/Uploads namespace
      await cw.send(new PutMetricDataCommand({
        Namespace: 'FoodApp/Uploads',
        MetricData: [
          {
            MetricName: 'ImageUploaded',
            Value: 1,
            Unit: 'Count',
            Dimensions: [{ Name: 'BucketName', Value: bucket }]
          },
          {
            MetricName: 'UploadSizeBytes',
            Value: size,
            Unit: 'Bytes',
            Dimensions: [{ Name: 'BucketName', Value: bucket }]
          }
        ]
      }));

      const result = {
        bucket,
        key,
        size,
        contentType,
        isImage,
        processedAt: new Date().toISOString(),
        publicUrl: `https://${bucket}.s3.ap-south-1.amazonaws.com/${key}`
      };

      console.log('[Lambda] Done:', JSON.stringify(result));
      results.push(result);

    } catch (err) {
      console.error('[Lambda] Error on', key, '-', err.message);
      results.push({ key, error: err.message });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ processed: results.length, results })
  };
};
