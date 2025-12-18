import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AWS_CONFIG } from './aws-config.js';

// AWS S3 Configuration
const s3Client = new S3Client({
  region: AWS_CONFIG.region,
  credentials: {
    accessKeyId: AWS_CONFIG.accessKeyId,
    secretAccessKey: AWS_CONFIG.secretAccessKey
  }
});

const BUCKET_NAME = AWS_CONFIG.bucketName;

// Upload file to S3
export const uploadToS3 = async (file, key) => {
  try {
    // Check if AWS credentials are configured
    if (!AWS_CONFIG.accessKeyId || !AWS_CONFIG.secretAccessKey || 
        AWS_CONFIG.accessKeyId === 'your_aws_access_key_id' ||
        AWS_CONFIG.secretAccessKey === 'your_aws_secret_access_key') {
      console.error('S3 Upload Error: AWS credentials not configured');
      return {
        success: false,
        error: 'AWS S3 credentials not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in environment variables. For local development, you may need to configure AWS S3 or use a development mode.'
      };
    }

    if (!BUCKET_NAME || BUCKET_NAME === 'your_bucket_name') {
      console.error('S3 Upload Error: Bucket name not configured');
      return {
        success: false,
        error: 'S3 bucket name not configured. Please set S3_BUCKET_NAME in environment variables.'
      };
    }

    console.log('S3 Upload - File details:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      bufferLength: file.buffer ? file.buffer.length : 'no buffer',
      key: key,
      bucket: BUCKET_NAME,
      region: AWS_CONFIG.region
    });

    if (!file.buffer || file.buffer.length === 0) {
      console.error('S3 Upload Error: File buffer is empty or missing');
      return {
        success: false,
        error: 'File buffer is empty or missing'
      };
    }

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Metadata: {
        originalName: file.originalname,
        uploadedAt: new Date().toISOString()
      },
      // Add cache control for image files (ACL not supported by this bucket)
      ...(file.mimetype && file.mimetype.startsWith('image/') ? {
        CacheControl: 'public, max-age=31536000'
      } : {})
    });

    const result = await s3Client.send(command);
    console.log('S3 Upload Success:', {
      etag: result.ETag,
      versionId: result.VersionId,
      uploadedSize: file.buffer.length
    });
    
    const region = AWS_CONFIG.region || 'eu-north-1';
    return {
      success: true,
      location: `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`,
      etag: result.ETag,
      versionId: result.VersionId
    };
  } catch (error) {
    console.error('S3 Upload Error:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.Code || error.code,
      statusCode: error.$metadata?.httpStatusCode
    });
    
    let errorMessage = error.message || 'Unknown S3 upload error';
    
    // Provide more specific error messages
    if (error.name === 'CredentialsProviderError' || error.message?.includes('credentials')) {
      errorMessage = 'AWS credentials are invalid or not configured. Please check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.';
    } else if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
      errorMessage = `S3 bucket "${BUCKET_NAME}" does not exist. Please check S3_BUCKET_NAME configuration.`;
    } else if (error.name === 'AccessDenied' || error.Code === 'AccessDenied') {
      errorMessage = 'Access denied to S3 bucket. Please check AWS credentials and bucket permissions.';
    } else if (error.message?.includes('ENOTFOUND') || error.message?.includes('network')) {
      errorMessage = 'Network error connecting to AWS S3. Please check your internet connection.';
    }
    
    return {
      success: false,
      error: errorMessage
    };
  }
};

// Delete file from S3
export const deleteFromS3 = async (key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    await s3Client.send(command);
    return { success: true };
  } catch (error) {
    console.error('S3 Delete Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Generate pre-signed URL for file access
export const generatePresignedUrl = async (key, expiresIn = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });
    return {
      success: true,
      url
    };
  } catch (error) {
    console.error('S3 Presigned URL Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Generate unique S3 key for Excel files
export const generateS3Key = (originalName, taskId) => {
  const timestamp = Date.now();
  const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `uploads/excel-files/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${taskId}_${timestamp}_${sanitizedName}`;
};

export { s3Client, BUCKET_NAME };
