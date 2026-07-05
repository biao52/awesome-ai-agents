# Technical Specifications

## API Overview

Base URL: `https://api.example.com/v2`

Authentication: Bearer token in the Authorization header
```
Authorization: Bearer your-api-key-here
```

## Rate Limits

| Plan | Requests/minute | Requests/day |
|------|----------------|-------------|
| Free | 10 | 100 |
| Pro | 60 | 10,000 |
| Enterprise | 300 | Unlimited |

Rate limit headers are included in every response:
- `X-RateLimit-Limit`: Your plan's limit
- `X-RateLimit-Remaining`: Requests remaining
- `X-RateLimit-Reset`: Unix timestamp when the limit resets

## Supported Formats

- **Input:** JSON, CSV, XML
- **Output:** JSON (default), CSV (with `Accept: text/csv` header)
- **File uploads:** Max 50MB per file, supported types: PDF, DOCX, TXT, PNG, JPG

## SDKs

Official SDKs are available for:
- Python: `pip install example-sdk`
- JavaScript/TypeScript: `npm install @example/sdk`
- Go: `go get github.com/example/sdk-go`

## Webhooks

You can configure webhooks to receive real-time notifications:
- Go to Settings > Webhooks in your dashboard
- Add your endpoint URL (must be HTTPS)
- Select which events to subscribe to
- We send a POST request with a JSON payload for each event
- Webhook requests timeout after 10 seconds
- Failed deliveries are retried 3 times with exponential backoff

## System Status

Check current system status at: https://status.example.com
Subscribe to status updates via email or RSS.
