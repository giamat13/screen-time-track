// Runs on every page (and frame). Reports whether any <video>/<audio> element
// is actively playing, and whether the current playback is a YouTube ad, so
// the desktop app can keep counting time while you watch real content but
// ignore ads / autoplay that run while you are away.
(function () {
  let state = { playing: false, ad: false };

  function anyMediaPlaying() {
    const media = document.querySelectorAll('video, audio');
    for (const m of media) {
      // readyState > 2 == HAVE_FUTURE_DATA or better (actually has frames).
      if (!m.paused && !m.ended && m.readyState > 2 && m.currentTime > 0) return true;
    }
    return false;
  }

  // YouTube tags the player element while an ad is on screen.
  function adPlaying() {
    const p = document.querySelector('.html5-video-player');
    return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  }

  function report(force) {
    const next = { playing: anyMediaPlaying(), ad: adPlaying() };
    if (force || next.playing !== state.playing || next.ad !== state.ad) {
      state = next;
      try {
        chrome.runtime.sendMessage({ type: 'media', playing: state.playing, ad: state.ad });
      } catch (e) { /* extension reloading / context invalidated */ }
    }
  }

  // Media events bubble in the capture phase even from nested players.
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'seeked']) {
    document.addEventListener(ev, () => report(false), true);
  }

  // While something plays, ping every 5s: this keeps the desktop app's view
  // fresh, re-checks the ad state, and wakes the background service worker
  // if Chrome put it to sleep.
  setInterval(() => report(state.playing), 5000);

  // First read shortly after load, once players have initialized.
  setTimeout(() => report(true), 1500);
})();
