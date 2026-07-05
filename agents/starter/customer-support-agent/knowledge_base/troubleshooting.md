# Troubleshooting Guide

## Common Issues

### "401 Unauthorized" Error
- Your API key may be invalid or expired
- Regenerate your API key at dashboard.example.com > Settings > API Keys
- Make sure you're using the correct header format: `Authorization: Bearer your-key`
- Check that there are no extra spaces or newline characters in your key

### "429 Too Many Requests" Error
- You've exceeded your plan's rate limit
- Check the `X-RateLimit-Reset` header to see when your limit resets
- Consider upgrading to a higher plan for increased limits
- Implement exponential backoff in your code for automatic retry

### "500 Internal Server Error"
- This is a server-side issue on our end
- Wait a few minutes and retry your request
- Check https://status.example.com for any ongoing incidents
- If the issue persists for more than 30 minutes, contact support

### Slow Response Times
- Check your internet connection first
- Use a server closer to our data centers (US East, EU West, APAC)
- Large file uploads may take longer to process
- Check https://status.example.com for any performance degradation

### Data Not Appearing in Dashboard
- Dashboard data updates every 5 minutes (not real-time)
- Try clearing your browser cache and refreshing
- Make sure you're looking at the correct date range
- API calls made with test keys don't appear in production dashboards

## Account Issues

### Can't Log In
- Try resetting your password at login.example.com/reset
- Check if your account email is correct
- If you use SSO, contact your IT admin to verify your SSO configuration
- Account may be locked after 5 failed login attempts (unlocks after 30 minutes)

### Need to Change Email
- Go to Settings > Account > Email
- You'll receive a verification link at the new email address
- Both old and new email addresses must be verified

### Delete Account
- Go to Settings > Account > Delete Account
- All data will be permanently deleted within 30 days
- Active subscriptions will be cancelled and prorated refund issued
- This action cannot be undone

## Still Need Help?

- Email: support@example.com (24-hour response time for Pro, 4-hour for Enterprise)
- Live chat: Available Monday-Friday, 9 AM - 6 PM EST at dashboard.example.com
- Community forum: community.example.com
