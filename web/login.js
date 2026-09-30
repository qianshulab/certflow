const form = document.getElementById('login-form');
document.getElementById('show-password').addEventListener('click', () => {
  const input = document.getElementById('password'), toggle = document.getElementById('show-password');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  toggle.textContent = reveal ? '隐藏' : '显示';
  toggle.setAttribute('aria-pressed', String(reveal));
  toggle.setAttribute('aria-label', reveal ? '隐藏管理密码' : '显示管理密码');
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('login-submit'), error = document.getElementById('login-error'), input = document.getElementById('password');
  if (button.disabled) return;
  button.disabled = true; error.textContent = ''; input.removeAttribute('aria-invalid');
  form.setAttribute('aria-busy', 'true'); document.getElementById('submit-label').textContent = '正在验证…';
  try {
    const response = await fetch('/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败，请重试。');
    input.value = ''; window.location.replace('/');
  } catch (failure) { error.textContent = failure.message === 'Failed to fetch' ? '无法连接管理服务，请检查容器是否运行。' : failure.message; input.setAttribute('aria-invalid', 'true'); input.focus(); }
  finally { button.disabled = false; form.removeAttribute('aria-busy'); document.getElementById('submit-label').textContent = '登录工作台'; }
});
