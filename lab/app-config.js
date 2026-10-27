// Test range: the kind of config file that accidentally ships a cloud key to every visitor.
// AKIAIOSFODNN7EXAMPLE is the example key from AWS's own documentation; it is not a real account.
window.APP_CONFIG = {
  apiBase: '/api',
  uploadBucket: 'test-range-uploads',
  awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  region: 'us-east-1',
};
