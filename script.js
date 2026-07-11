/**
 * HAIN Portfolio — 壁虎頭部滑鼠互動控制
 *
 * 核心規格（嚴格遵守）：
 *  - video: muted / playsinline / preload="auto" / 無 autoplay / 無 loop / 無 controls
 *  - 不呼叫 video.play()
 *  - delta = currentX - prevX
 *  - timeOffset = (delta / innerWidth) * 0.8 * duration
 *  - targetTime = targetTime - timeOffset  （反向：左移→看左，右移→看右）
 *  - targetTime 限制在 [0, duration]
 *  - 排隊 seek：未 seek 時立即執行，seek 中只更新 targetTime，seeked 後再追趕
 *  - 初始停在第一影格（currentTime = 0）
 */

(function () {
    'use strict';

    /* ── 狀態 ─────────────────────────────────────── */
    var video      = null;
    var duration   = 0;
    var targetTime = 0;
    var prevX      = null;
    var ready      = false;
    var seeking    = false;
    var seekTimeout = null; // 解鎖安全定時器，避免 Chrome 在無 Range 請求伺服器下 seek 永久鎖死

    /* ── 初始化 ────────────────────────────────────── */
    function tryInit() {
        if (ready) return;
        if (!video) return;
        if (video.readyState < 1) return; // 確保中繼資料已就緒，防堵 Chrome 未加載 readyState

        var d = video.duration;
        if (!d || d !== d || !isFinite(d) || d <= 0) return; // NaN / Infinity / 0

        duration   = d;
        ready      = true;
        targetTime = d / 2; // 預設視線停在正中間（看著正前方）

        try { video.currentTime = d / 2; } catch (e) {}

        console.log('[HAIN] 影片就緒，duration =', duration.toFixed(3), 's');
    }

    function doSeek() {
        if (!ready || seeking) return;
        if (video.readyState < 1) return; // 確保 readyState 允許尋軌

        var diff = Math.abs(video.currentTime - targetTime);
        if (diff < 0.005) return; // 差距極小，跳過

        seeking = true;

        // 150ms 強制解鎖安全鎖，防堵 Range 請求缺失導致影片掛起
        if (seekTimeout) clearTimeout(seekTimeout);
        seekTimeout = setTimeout(function () {
            if (seeking) {
                seeking = false;
                doSeek(); // 強制解除鎖定並追趕
            }
        }, 150);

        try {
            video.currentTime = targetTime;
        } catch (e) {
            seeking = false; // 異常時解鎖
            if (seekTimeout) clearTimeout(seekTimeout);
        }
    }

    /* ── 滑鼠位移計算 ──────────────────────────────── */
    function processX(currentX) {
        if (!ready) return;
        if (window.isBugEaten) return; // 正在咬食中，不接收滑鼠控制影片

        if (prevX === null) {
            prevX = currentX;
            // 第一次偵測到滑鼠（或滑鼠離屏重入）時，絕對對齊滑鼠坐標，徹底解決初始偏差與雙螢幕偏移問題
            targetTime = (1.0 - (currentX / window.innerWidth)) * duration;
            targetTime = Math.max(0, Math.min(duration, targetTime));
            doSeek();
            return;
        }

        var delta      = currentX - prevX;
        prevX          = currentX;

        var timeOffset = (delta / window.innerWidth) * 0.8 * duration;
        targetTime     = targetTime - timeOffset;
        targetTime     = Math.max(0, Math.min(duration, targetTime));

        doSeek();
    }

    /* ── 掛載事件（在 DOM 就緒後執行） ─────────────── */
    function mount() {
        video = document.getElementById('bg-video');
        var eatVideo = document.getElementById('eat-video');

        if (!video) {
            console.error('[HAIN] 找不到 #bg-video');
            return;
        }

        // 強制影片載入，解決 Chrome/Edge 有時卡在 readyState=0 的問題
        try {
            video.load();
            if (eatVideo) eatVideo.load();
        } catch (e) {
            console.warn('[HAIN] 影片加載啟動受阻:', e);
        }

        // 初始化全域吃蟲狀態
        window.isBugEaten = false;

        /* seeked：解鎖並追趕 */
        video.addEventListener('seeked', function () {
            if (seekTimeout) clearTimeout(seekTimeout);
            seeking = false;
            doSeek();
        });

        /* 監聽所有可能帶出 duration 的影片事件 */
        ['loadedmetadata', 'durationchange', 'canplay', 'canplaythrough'].forEach(function (evt) {
            video.addEventListener(evt, tryInit);
        });

        /* 若已緩存（readyState >= 1 = HAVE_METADATA），直接嘗試 */
        tryInit();

        /* 終極保底：每 80ms 輪詢一次，直到 duration 有效 */
        var poll = setInterval(function () {
            tryInit();
            if (ready) clearInterval(poll);
        }, 80);

        /* 滑鼠 mousemove */
        window.addEventListener('mousemove', function (e) {
            processX(e.clientX);
        });

        /* 觸控 touchmove（手機端） */
        window.addEventListener('touchmove', function (e) {
            if (e.touches && e.touches[0]) {
                processX(e.touches[0].clientX);
            }
        }, { passive: true });

        /* 滑鼠離開視窗時重置 prevX，防止重新進入時發生大幅跳躍 */
        document.addEventListener('mouseleave', function () {
            prevX = null;
        });

        /* 實作咬食影片播控 */
        window.playGeckoEat = function () {
            if (!eatVideo) return;
            
            // 隱藏轉頭影片，顯示咬食影片
            video.style.display = 'none';
            eatVideo.style.display = 'block';
            
            eatVideo.currentTime = 0;
            var playPromise = eatVideo.play();
            
            if (playPromise !== undefined) {
                playPromise.catch(function (error) {
                    console.warn('[HAIN] 咬食影片播放受限 (無瀏覽器互動許可)，執行自動復原:', error);
                    // 備份：萬一播放失敗，1秒後強制復原
                    setTimeout(function () {
                        if (window.respawnBug) window.respawnBug();
                    }, 1000);
                });
            }
        };

        /* 監聽咬食結束事件，切換回轉頭影片並跳轉或觸發昆蟲重生 */
        if (eatVideo) {
            eatVideo.addEventListener('ended', function () {
                var targetHref = window.getTransitionHref ? window.getTransitionHref() : '#';
                if (targetHref && targetHref !== '#' && !targetHref.startsWith('javascript:')) {
                    // 執行頁面跳轉
                    window.location.href = targetHref;
                    return;
                }

                // 如果是測試用的空連結，則重置狀態供使用者重複測試
                eatVideo.style.display = 'none';
                video.style.display = 'block';
                document.body.classList.remove('transition-active');
                var overlay = document.querySelector('.transition-overlay');
                if (overlay) overlay.classList.remove('active');

                // 將轉頭影片的目標時間軸平滑重設為中間（正對前方）
                targetTime = duration / 2;
                prevX = null; // 重置滑鼠坐標，使下一次移動時重新絕對對齊
                try {
                    video.currentTime = targetTime;
                } catch (e) {}

                // 吞嚥後等待 1000ms（消化延遲），觸發昆蟲在滑鼠位置重生
                setTimeout(function () {
                    if (window.respawnBug) {
                        window.respawnBug();
                    }
                }, 1000);
            });
        }
    }

    /* ── 入口 ──────────────────────────────────────── */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        // script 在 body 底部，DOM 已就緒，直接執行
        mount();
    }

}());
