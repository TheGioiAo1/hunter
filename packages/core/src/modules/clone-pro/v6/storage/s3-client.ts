import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

export function buildS3Client(opts: { region: string; accessKeyId?: string; secretAccessKey?: string }): S3Client {
  return new S3Client({
    region: opts.region,
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
  })
}

export interface PutInput {
  client: S3Client
  bucket: string
  key: string
  body: Buffer
  contentType: string
}

export interface PutResult {
  uploaded: boolean
  skipped: boolean
}

export async function putObjectIfAbsent(input: PutInput): Promise<PutResult> {
  try {
    await input.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }))
    return { uploaded: false, skipped: true }
  } catch (err: any) {
    if (err?.name !== 'NotFound' && err?.$metadata?.httpStatusCode !== 404) throw err
  }
  // Modern S3 buckets default to "Bucket owner enforced" (ACLs disabled).
  // Public-read access is granted by bucket-level policy, not per-object ACL.
  // See: https://docs.aws.amazon.com/AmazonS3/latest/userguide/about-object-ownership.html
  await input.client.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return { uploaded: true, skipped: false }
}
