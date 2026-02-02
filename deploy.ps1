# Cloudflare Worker 自动部署脚本
$env:CLOUDFLARE_API_KEY="f09a7982f7762f3fbd41a024b8639596c126f"
$env:CLOUDFLARE_EMAIL="912741793@qq.com"

Write-Host "🚀 正在部署到 Cloudflare..." -ForegroundColor Green
npx wrangler deploy

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 部署成功！" -ForegroundColor Green
} else {
    Write-Host "❌ 部署失败" -ForegroundColor Red
}
