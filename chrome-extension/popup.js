'use strict';
function check() {
  document.getElementById('status').textContent = 'Checking…';
  document.getElementById('dot').className = 'dot';
  document.getElementById('detail').textContent = '';
  chrome.runtime.sendMessage({ type: 'ghq-status' }, function (res) {
    if (chrome.runtime.lastError) {
      document.getElementById('status').textContent = 'Extension error';
      document.getElementById('detail').textContent = chrome.runtime.lastError.message;
      document.getElementById('dot').className = 'dot bad';
      return;
    }
    if (!res || !res.ok) {
      document.getElementById('status').textContent = 'Not connected';
      document.getElementById('detail').textContent = (res && res.error) || 'Gridiron HQ is not reachable';
      document.getElementById('dot').className = 'dot bad';
      return;
    }
    if (!res.draft) {
      document.getElementById('status').textContent = 'No live draft yet';
      document.getElementById('detail').textContent = 'Open the ESPN draft room when it starts — this attaches automatically, no click needed.';
      document.getElementById('dot').className = 'dot';
      return;
    }
    document.getElementById('status').textContent = 'Ready: ' + res.draft.name;
    document.getElementById('detail').textContent = 'Open the ESPN draft room and it feeds Gridiron HQ automatically.';
    document.getElementById('dot').className = 'dot ok';
  });
}
document.getElementById('refresh').addEventListener('click', check);
document.getElementById('resync').addEventListener('click', function () {
  var note = document.getElementById('resync-note');
  note.textContent = 'Nudging the draft room to reconnect…';
  chrome.runtime.sendMessage({ type: 'ghq-resync' }, function (res) {
    if (chrome.runtime.lastError) { note.textContent = chrome.runtime.lastError.message; return; }
    if (!res || !res.ok) { note.textContent = (res && res.error) || 'Could not resync'; return; }
    note.textContent = res.closed
      ? 'Reconnecting now — the full pick list arrives within a few seconds.'
      : 'Armed — it reconnects on the next ESPN clock tick (a few seconds), then the full pick list arrives.';
  });
});
check();
