// mic-permission.js — asks for the microphone once, in a normal tab.
// The side panel can't show Chrome's permission prompt; once it's granted
// here, it applies to the whole extension, side panel included.
(async () => {
  const title = document.getElementById('title');
  const msg = document.getElementById('msg');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());   // only the permission was needed
    title.textContent = '✅ Microphone allowed';
    title.className = 'ok';
    msg.textContent = 'You can answer the interviewer by voice now. This tab closes by itself.';
    chrome.runtime.sendMessage({ type: 'MIC_GRANTED' }).catch(() => {});
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    title.textContent = '⚠️ Microphone blocked';
    title.className = 'err';
    msg.textContent = 'Allow it with the camera/microphone icon at the right end of the address bar, then reload this page. You can still type your answers in the interview.';
  }
})();
