const form = document.getElementById('login-form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button'), error = document.getElementById('login-error'), input = document.getElementById('password');
  button.disabled = true; error.textContent = '';
  try {
    const response = await fetch('/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败，请重试。');
    input.value = ''; window.location.replace('/');
  } catch (failure) { error.textContent = failure.message === 'Failed to fetch' ? '无法连接管理服务，请检查容器是否运行。' : failure.message; }
  finally { button.disabled = false; }
});
