// ============================================
// MK-DWELL - Input Handler
// ============================================

const DwellInput = (function() {
    let cursor = null;
    let isActive = false;
    let lastPosition = { x: 0.5, y: 0.5 };
    let velocity = 0;
    let lastMoveTime = 0;

    // Smoothing for velocity calculation
    const VELOCITY_SMOOTHING = 0.1;
    const VELOCITY_DECAY = 0.95;

    function init() {
        cursor = document.querySelector('.cursor');
        if (!cursor) {
            cursor = document.createElement('div');
            cursor.className = 'cursor hidden';
            document.body.appendChild(cursor);
        }

        // Mouse events
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseenter', () => showCursor());
        document.addEventListener('mouseleave', () => hideCursor());

        // Touch events
        document.addEventListener('touchstart', handleTouch, { passive: true });
        document.addEventListener('touchmove', handleTouch, { passive: true });
        document.addEventListener('touchend', handleTouchEnd);

        // Start velocity decay loop
        requestAnimationFrame(updateVelocity);
    }

    function handleMove(e) {
        if (!isActive) return;

        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;

        updatePosition(x, y, e.clientX, e.clientY);
    }

    function handleTouch(e) {
        if (!isActive || !e.touches.length) return;

        const touch = e.touches[0];
        const x = touch.clientX / window.innerWidth;
        const y = touch.clientY / window.innerHeight;

        updatePosition(x, y, touch.clientX, touch.clientY);
    }

    function handleTouchEnd() {
        // Keep last position, just stop updating
    }

    function updatePosition(x, y, screenX, screenY) {
        // Calculate velocity from movement
        const dx = x - lastPosition.x;
        const dy = y - lastPosition.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const now = performance.now();
        const dt = now - lastMoveTime;

        if (dt > 0) {
            const instantVelocity = distance / (dt / 1000);
            velocity = velocity * (1 - VELOCITY_SMOOTHING) + instantVelocity * VELOCITY_SMOOTHING;
        }

        lastPosition.x = x;
        lastPosition.y = y;
        lastMoveTime = now;

        // Update cursor position
        if (cursor) {
            cursor.style.left = screenX + 'px';
            cursor.style.top = screenY + 'px';
        }

        // Send to audio engine
        if (typeof DwellAudio !== 'undefined') {
            DwellAudio.setPosition(x, y);
        }
    }

    function updateVelocity() {
        // Decay velocity over time
        velocity *= VELOCITY_DECAY;

        // Could send velocity to audio for event density
        // DwellAudio.setEventDensity(velocity);

        requestAnimationFrame(updateVelocity);
    }

    function showCursor() {
        if (cursor) {
            cursor.classList.remove('hidden');
        }
    }

    function hideCursor() {
        if (cursor) {
            cursor.classList.add('hidden');
        }
    }

    function activate() {
        isActive = true;
        showCursor();
    }

    function deactivate() {
        isActive = false;
        hideCursor();
    }

    return {
        init: init,
        activate: activate,
        deactivate: deactivate,
        getPosition: function() {
            return { ...lastPosition };
        },
        getVelocity: function() {
            return velocity;
        }
    };
})();
