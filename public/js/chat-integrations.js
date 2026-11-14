// Progressive enhancement; authorization and permission enforcement are server-owned.
document.querySelectorAll('form').forEach(form => {
  const update = () => {
    const target = form.querySelector('[data-scopes]');
    if (!target) return;
    target.value = Array.from(form.querySelectorAll('select[name]')).flatMap(select =>
      select.value === 'off' ? [] : select.value === 'write' ? [`dcc.${select.name}.read`, `dcc.${select.name}.write`] : [`dcc.${select.name}.read`]
    ).join(' ');
  };
  form.querySelector('[data-select-all]')?.addEventListener('click', () => {
    form.querySelectorAll('select').forEach(select => {
      if (select.querySelector('option[value="write"]')) select.value = 'write';
    });
    update();
  });
  form.addEventListener('change', update);
  update();
});
async function copy(value) {
  const status = document.querySelector('[data-copy-status]');
  try {
    await navigator.clipboard.writeText(value);
    if (status) status.textContent = 'Copied.';
  } catch {
    if (status) status.textContent = 'Select the text above and copy it.';
  }
}
document.querySelector('[data-copy-scopes]')?.addEventListener('click', () => copy(document.querySelector('[data-scopes]').value));
document.querySelector('[data-copy-server]')?.addEventListener('click', () => copy(document.querySelector('[data-server-url]').textContent));
