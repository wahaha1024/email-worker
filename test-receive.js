// 测试邮件接收功能
const testEmail = {
  from: 'Test Sender <test@example.com>',
  to: 'recipient@zjyyy.top',
  subject: 'Test Email ' + new Date().toISOString(),
  text: 'This is a test email body.\n\nSent at: ' + new Date(),
  html: '<p>This is a <b>test</b> email body.</p><p>Sent at: ' + new Date() + '</p>'
};

// 构建 form data
const formData = new URLSearchParams();
Object.entries(testEmail).forEach(([key, value]) => {
  formData.append(key, value);
});

console.log('Testing email receive endpoint...');
console.log('Sending:', testEmail);

fetch('https://email.zjyyy.top/api/receive', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: formData.toString()
})
.then(res => res.json())
.then(data => {
  console.log('Response:', data);
})
.catch(err => {
  console.error('Error:', err);
});
