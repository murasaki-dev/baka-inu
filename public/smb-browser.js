export function initSmbBrowser({ request, post, bridge, notify, getUser }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#smb-dialog'), select = $('#smb-share'), files = $('#smb-files'), status = $('#smb-status');
  let shares = [], folder = '', page = 1, pages = 1, loadId = 0, editingId = null;
  let authShareId = null;
  const selected = new Map();
  let visibleVideos = [], busy = false, folderReady = false;
  const authDialog = $('#smb-auth-dialog');
  function showSignIn(share, reason = '') {
    if (!share) return;
    authShareId = share.id;
    $('#smb-auth-description').textContent = `${share.name} · ${new URL(share.url).hostname}`;
    $('#smb-auth-username').value = share.username || '';
    $('#smb-auth-domain').value = share.domain || '';
    $('#smb-auth-password').value = '';
    $('#smb-auth-error').textContent = reason;
    $('#smb-auth-forget').hidden = !share.has_credentials;
    $('#smb-auth-remember').checked = true;
    if (!authDialog.open) authDialog.showModal();
    $('#smb-auth-username').focus();
  }
  function resetBookmarkForm() {
    editingId = null;
    $('#smb-share-form').reset();
    $('#smb-share-form-heading').textContent = 'Bookmark a share';
    $('#smb-share-save').textContent = 'Save bookmark';
    $('#smb-share-edit-cancel').hidden = true;
  }
  function message(text, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
  function renderShares(preferred = select.value) {
    select.replaceChildren();
    for (const share of shares) {
      const option = document.createElement('option'); option.value = share.id; option.textContent = `${share.name}${share.has_credentials ? ' · account configured' : ''}`; select.append(option);
    }
    if (shares.some((share) => share.id === preferred)) select.value = preferred;
    select.disabled = !shares.length; $('#smb-share-remove').disabled = !shares.length;
    $('#smb-share-edit').disabled = !shares.length;
    $('#smb-share-signin').disabled = !shares.length;
    $('#smb-share-signin').textContent = shares.find((share) => share.id === select.value)?.has_credentials ? 'Edit sign-in' : 'Sign in';
  }
  function breadcrumbs() {
    const container = $('#smb-breadcrumbs'); container.replaceChildren();
    const share = shares.find((item) => item.id === select.value);
    const parts = folder.split('/').filter(Boolean);
    for (let index = 0; index <= parts.length; index += 1) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'smb-crumb';
      button.textContent = index ? parts[index - 1] : share?.name || 'Shares';
      button.addEventListener('click', () => browse(parts.slice(0, index).join('/')));
      container.append(button);
    }
    $('#smb-up').disabled = !folder || !share;
    $('#smb-bookmark-folder').disabled = !folderReady || !folder || !share || busy;
  }
  const playbackItem = (entry) => ({ url: entry.url, title: entry.name, local: true, quality: getUser()?.quality || '720' });
  function updateSelection() {
    const all = $('#smb-select-all'), count = visibleVideos.filter((entry) => selected.has(entry.url)).length;
    all.checked = visibleVideos.length > 0 && count === visibleVideos.length;
    all.indeterminate = count > 0 && count < visibleVideos.length;
    all.disabled = busy || !visibleVideos.length;
    $('#smb-selected-count').textContent = `${selected.size} selected`;
    for (const id of ['smb-selection-clear', 'smb-selection-next', 'smb-selection-last']) $('#'+id).disabled = busy || !selected.size;
    for (const checkbox of files.querySelectorAll('input[type=checkbox]')) { checkbox.checked = selected.has(checkbox.dataset.url); checkbox.disabled = busy; }
    for (const button of files.querySelectorAll('button')) button.disabled = busy;
    select.disabled = busy || !shares.length;
    for (const id of ['smb-share-remove', 'smb-share-edit', 'smb-share-signin']) $('#'+id).disabled = busy || !shares.length;
    breadcrumbs();
  }
  function clearSelection() { selected.clear(); updateSelection(); }
  async function queueFile(entry, action) {
    if (busy) return;
    busy = true; updateSelection();
    try {
      const route = { now: '/play_preserve_queue', next: '/queue_next', last: '/queue' }[action];
      const okay = await bridge(route, { ...playbackItem(entry), at_end: action === 'last' });
      if (okay) { message(`${action === 'now' ? 'Playing now' : action === 'next' ? 'Playing next' : 'Added last'}: ${entry.name}`); notify(action === 'now' ? 'Playing video' : 'Added to queue'); }
    } catch (error) { message(error.message, true); }
    finally { busy = false; updateSelection(); }
  }
  async function queueSelected(mode) {
    if (busy || !selected.size) return;
    const entries = [...selected.values()];
    busy = true; updateSelection();
    try {
      const okay = await bridge('/queue_batch', { mode, items: entries.map(playbackItem) });
      if (okay) { selected.clear(); message(`${entries.length} videos added ${mode === 'next' ? 'next' : 'last'}, in selection order.`); notify('Selected videos added to queue'); }
    } catch (error) { message(error.message, true); }
    finally { busy = false; updateSelection(); }
  }
  function renderEntries(entries) {
    visibleVideos = entries.filter((entry) => !entry.directory);
    files.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div'); row.className = 'smb-file-row';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'smb-file-name';
      const icon = document.createElement('span'); icon.className = 'smb-file-icon'; icon.textContent = entry.directory ? '▱' : '▷'; icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.textContent = entry.name;
      name.append(icon, label); name.title = entry.directory ? `Open ${entry.name}` : `Play ${entry.name} now`;
      name.addEventListener('click', () => entry.directory ? browse(entry.path) : queueFile(entry, 'now'));
      if (!entry.directory) {
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.url = entry.url; checkbox.setAttribute('aria-label', `Select ${entry.name}`);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked && selected.size >= 200) { checkbox.checked = false; message('Select up to 200 videos at a time.', true); return; }
          if (checkbox.checked) selected.set(entry.url, entry); else selected.delete(entry.url);
          updateSelection();
        });
        row.append(checkbox);
      }
      row.append(name);
      if (!entry.directory) {
        const size = document.createElement('span'); size.className = 'smb-file-size';
        size.textContent = entry.size >= 1024 ** 3 ? `${(entry.size / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(entry.size / 1024 ** 2)} MB`;
        const next = document.createElement('button'); next.type = 'button'; next.className = 'button subtle'; next.textContent = 'Play next';
        next.addEventListener('click', () => queueFile(entry, 'next'));
        const last = document.createElement('button'); last.type = 'button'; last.className = 'button subtle'; last.textContent = 'Play last';
        last.addEventListener('click', () => queueFile(entry, 'last')); row.append(size, next, last);
      }
      files.append(row);
    }
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No folders or supported video files here.'; files.append(empty); }
    updateSelection();
  }
  async function browse(nextFolder = '', nextPage = 1) {
    const currentLoad = ++loadId;
    folder = nextFolder; page = nextPage;
    folderReady = false; visibleVideos = []; files.replaceChildren(); updateSelection();
    $('#smb-prev').disabled = true; $('#smb-next').disabled = true; $('#smb-page').textContent = '';
    if (!select.value) { message('Bookmark a share to start browsing.'); $('#smb-refresh').disabled = true; return; }
    $('#smb-refresh').disabled = false; message('Loading folder…');
    try {
      const query = new URLSearchParams({ share: select.value, folder, page: String(page) });
      const data = await request(`/api/admin/smb/browse?${query}`);
      if (currentLoad !== loadId || !dialog.open) return;
      folder = data.folder; page = data.page; pages = data.pages;
      folderReady = true; renderEntries(data.entries);
      message(`${data.total} folders and videos`);
      $('#smb-page').textContent = `Page ${page} of ${pages}`;
      $('#smb-prev').disabled = page <= 1; $('#smb-next').disabled = page >= pages;
    } catch (error) {
      if (currentLoad === loadId && dialog.open) {
        message(error.message, true);
        if (error.code === 'SMB_AUTH_REQUIRED') showSignIn(shares.find((share) => share.id === select.value), error.message);
      }
    }
  }
  $('#smb-open').addEventListener('click', async () => {
    if (!getUser()?.is_admin || dialog.open) return;
    dialog.showModal(); message('Loading bookmarks…'); visibleVideos = []; folderReady = false; files.replaceChildren(); clearSelection();
    try { const data = await request('/api/admin/smb/shares'); if (!dialog.open) return; shares = data.shares; renderShares(); await browse(); }
    catch (error) { message(error.message, true); }
  });
  $('#smb-share-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return; const button = event.submitter; if (button) button.disabled = true;
    try {
      const body = { name: $('#smb-share-name').value, url: $('#smb-share-url').value.trim(), ...(editingId ? { id: editingId } : {}) };
      const data = await request('/api/admin/smb/shares', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body) });
      const selectedId = editingId || data.shares.at(-1)?.id;
      shares = data.shares; renderShares(selectedId); clearSelection(); resetBookmarkForm(); $('.smb-add-share').open = false; await browse();
    } catch (error) { message(error.message, true); }
    finally { if (button) button.disabled = false; }
  });
  $('#smb-share-remove').addEventListener('click', async () => {
    try { const data = await request('/api/admin/smb/shares', { method: 'DELETE', body: JSON.stringify({ id: select.value }) }); shares = data.shares; resetBookmarkForm(); renderShares(); clearSelection(); await browse(); }
    catch (error) { message(error.message, true); }
  });
  $('#smb-share-edit').addEventListener('click', () => {
    const share = shares.find((item) => item.id === select.value);
    if (!share) return;
    editingId = share.id;
    $('#smb-share-name').value = share.name; $('#smb-share-url').value = share.url;
    $('#smb-share-form-heading').textContent = 'Edit bookmark'; $('#smb-share-save').textContent = 'Save changes';
    $('#smb-share-edit-cancel').hidden = false; $('.smb-add-share').open = true; $('#smb-share-name').focus();
  });
  $('#smb-share-edit-cancel').addEventListener('click', resetBookmarkForm);
  $('#smb-share-signin').addEventListener('click', () => showSignIn(shares.find((share) => share.id === select.value)));
  $('#smb-auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
    $('#smb-auth-error').textContent = '';
    try {
      const data = await post('/api/admin/smb/credentials', { id: authShareId, username: $('#smb-auth-username').value, password: $('#smb-auth-password').value, domain: $('#smb-auth-domain').value, remember: $('#smb-auth-remember').checked });
      shares = data.shares; renderShares(authShareId); authDialog.close(); await browse(folder);
    } catch (error) { $('#smb-auth-error').textContent = error.message; }
    finally { $('#smb-auth-password').value = ''; if (button) button.disabled = false; }
  });
  $('#smb-auth-forget').addEventListener('click', async () => {
    try {
      const data = await request('/api/admin/smb/credentials', { method: 'DELETE', body: JSON.stringify({ id: authShareId }) });
      shares = data.shares; renderShares(authShareId); authDialog.close(); message('Saved sign-in cleared. Refresh to try guest access.');
    } catch (error) { $('#smb-auth-error').textContent = error.message; }
  });
  authDialog.addEventListener('close', () => { $('#smb-auth-password').value = ''; });
  $('#smb-bookmark-folder').addEventListener('click', async () => {
    const share = shares.find((item) => item.id === select.value);
    if (!share || !folder || !folderReady || busy) return;
    const url = `${share.url}/${folder.split('/').map(encodeURIComponent).join('/')}`;
    const existing = shares.find((item) => item.url === url);
    if (existing) { message(`Already bookmarked as ${existing.name}.`); return; }
    busy = true; updateSelection();
    try {
      const data = await post('/api/admin/smb/shares', { name: folder.split('/').at(-1), url, inherit_from: share.id });
      shares = data.shares; renderShares(share.id); message('Current folder bookmarked.'); notify('Folder bookmarked');
    } catch (error) { message(error.message, true); }
    finally { busy = false; updateSelection(); }
  });
  $('#smb-select-all').addEventListener('change', (event) => {
    const checked = event.target.checked;
    for (const entry of visibleVideos) {
      if (!checked) selected.delete(entry.url);
      else if (selected.size < 200) selected.set(entry.url, entry);
    }
    if (checked && visibleVideos.some((entry) => !selected.has(entry.url))) message('Select up to 200 videos at a time.', true);
    updateSelection();
  });
  $('#smb-selection-clear').addEventListener('click', clearSelection);
  $('#smb-selection-next').addEventListener('click', () => queueSelected('next'));
  $('#smb-selection-last').addEventListener('click', () => queueSelected('last'));
  select.addEventListener('change', () => { resetBookmarkForm(); renderShares(); clearSelection(); void browse(); });
  $('#smb-up').addEventListener('click', () => browse(folder.split('/').slice(0, -1).join('/')));
  $('#smb-refresh').addEventListener('click', () => browse(folder, page));
  $('#smb-prev').addEventListener('click', () => { if (page > 1) void browse(folder, page - 1); });
  $('#smb-next').addEventListener('click', () => { if (page < pages) void browse(folder, page + 1); });
  dialog.addEventListener('close', () => { loadId += 1; folderReady = false; resetBookmarkForm(); });
}
