// ============================================
// MK-DWELL - Main Controller
// ============================================

(function() {
    'use strict';

    // Elements
    const entryScreen = document.getElementById('entry');
    const enterBtn = document.getElementById('enterBtn');
    const soundSpace = document.getElementById('space');
    const knowHowBtn = document.getElementById('knowHow');
    const knowHowPanel = document.getElementById('knowHowPanel');

    // State
    let hasEntered = false;

    // Initialize
    function init() {
        DwellInput.init();

        // Entry button
        enterBtn.addEventListener('click', enter);
        enterBtn.addEventListener('touchend', function(e) {
            e.preventDefault();
            enter();
        });

        // Know how
        knowHowBtn.addEventListener('click', function() {
            if (isKnowHowOpen()) {
                closeKnowHow(false);
            } else {
                openKnowHow();
            }
        });
        document.addEventListener('pointerdown', function(e) {
            if (isKnowHowOpen() && !knowHowPanel.contains(e.target) && !knowHowBtn.contains(e.target)) {
                closeKnowHow(false);
            }
        });

        // Keyboard support
        document.addEventListener('keydown', function(e) {
            // Esc peels one layer at a time: know how first, then the space
            if (e.key === 'Escape' && isKnowHowOpen()) {
                closeKnowHow(true);
                return;
            }
            // A focused link or button keeps its own Enter/Space
            const onControl = e.target !== enterBtn && e.target.closest && e.target.closest('a, button');
            if (!hasEntered && (e.key === 'Enter' || e.key === ' ') && !onControl && !isKnowHowOpen() && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                enter();
            }
            // Escape to leave
            if (hasEntered && e.key === 'Escape') {
                leave();
            }
        });
    }

    function isKnowHowOpen() {
        return !knowHowPanel.hidden;
    }

    function openKnowHow() {
        knowHowPanel.hidden = false;
        knowHowBtn.setAttribute('aria-expanded', 'true');
        knowHowPanel.focus({ preventScroll: true });
    }

    function closeKnowHow(returnFocus) {
        if (!isKnowHowOpen()) return;
        knowHowPanel.hidden = true;
        knowHowBtn.setAttribute('aria-expanded', 'false');
        if (returnFocus) knowHowBtn.focus();
    }

    function enter() {
        if (hasEntered) return;
        hasEntered = true;

        closeKnowHow(false);

        // Start audio
        DwellAudio.start();

        // Fade out entry screen
        entryScreen.classList.add('fade-out');

        // Show sound space after fade
        setTimeout(function() {
            if (!hasEntered) return;
            entryScreen.style.display = 'none';
            soundSpace.classList.remove('hidden');

            // Activate input
            DwellInput.activate();
        }, 1000);
    }

    function leave() {
        if (!hasEntered) return;

        // Stop audio
        DwellAudio.stop();

        // Deactivate input
        DwellInput.deactivate();

        // Reset UI
        soundSpace.classList.add('hidden');
        entryScreen.style.display = '';
        entryScreen.classList.remove('fade-out');

        hasEntered = false;
    }

    // Start when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
