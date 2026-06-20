const params = new URLSearchParams(window.location.search);
const message = params.get('message') || 'Reminder!';
const time = params.get('time') || '';

document.getElementById('popup-message').textContent = message;
const timeEl = document.getElementById('popup-time');
if (time) {
  timeEl.textContent = time;
} else {
  timeEl.style.display = 'none';
}

let phase = 'initial'; // 'initial' | 'counting' | 'ready'
let n = 5;

const btn = document.getElementById('popup-close');
const cd = document.getElementById('countdown');
const cdNum = document.getElementById('countdown-n');

btn.addEventListener('click', () => {
  if (phase === 'initial') {
    // First click: start countdown
    phase = 'counting';
    btn.disabled = true;
    btn.textContent = 'Close';
    cd.classList.remove('hidden');
    const tick = setInterval(() => {
      n--;
      cdNum.textContent = n;
      if (n <= 0) {
        clearInterval(tick);
        phase = 'ready';
        cd.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = 'Close now';
        btn.classList.add('ready');
      }
    }, 1000);
  } else if (phase === 'ready') {
    // Second click: close
    window.close();
  }
});
