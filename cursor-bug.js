/**
 * cursor-bug.js  —  3D 昆蟲游標
 *
 * 載入 A01.fbx (身體) + A02.fbx + A03.fbx (翅膀)
 * 用滑鼠位置驅動昆蟲跟隨，左右方向轉向，翅膀獨立振動。
 *
 * 規格遵守：
 *  - 不修改影片 / UI / script.js 的任何邏輯
 *  - canvas overlay: pointer-events:none → 滑鼠事件正常穿透
 *  - 只改變昆蟲 yaw（Y軸），pitch 極度限制，roll 永遠為 0
 *  - 翅膀繞翅根旋轉，左右鏡像，非整體震動
 */

import * as THREE       from 'three';
import { FBXLoader }    from 'three/addons/loaders/FBXLoader.js';

if (window.__bugCursorLoaded) {
    console.warn('[BugCursor] 偵測到重複載入，已自動忽略此 Instance。');
} else {
    window.__bugCursorLoaded = true;

    // 清理舊的 Canvas，防止重複載入時產生疊影
    const oldCanvas = document.getElementById('bug-cursor-canvas');
    if (oldCanvas) {
        try {
            oldCanvas.remove();
            console.log('[BugCursor] 已成功清理舊的 Canvas。');
        } catch (e) {}
    }

    // ═══════════════════════════════════════════════════════════
    // 1. Canvas overlay
    // ═══════════════════════════════════════════════════════════
    const canvas = document.createElement('canvas');
    canvas.id    = 'bug-cursor-canvas';
    Object.assign(canvas.style, {
        position:      'fixed',
        top:           '0',
        left:          '0',
        width:         '100vw',
        height:        '100vh',
        pointerEvents: 'none',
        zIndex:        '1000000',   // 高於彈窗 (100000) 確保昆蟲游標在彈窗開啟時仍然顯示在最上層
    });
    document.body.appendChild(canvas);

    // 建立 Debug 狀態面板，方便在畫面上直接看見狀態，免去快取或 F12 的溝通誤差
    const debugDiv = document.createElement('div');
    debugDiv.id = 'bug-cursor-debug';
    Object.assign(debugDiv.style, {
        position: 'fixed',
        bottom: '10px',
        left: '10px',
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#00ff00',
        padding: '10px 15px',
        fontFamily: 'monospace',
        fontSize: '11px',
        borderRadius: '5px',
        zIndex: '10000000',
        pointerEvents: 'none',
        lineHeight: '1.5',
        boxShadow: '0 0 10px rgba(0,0,0,0.5)',
        border: '1px solid #00ff00'
    });
    document.body.appendChild(debugDiv);

    function updateDebugPanel() {
        debugDiv.innerHTML = `
            <b>[BugCursor Debug V7]</b><br>
            Loaded: ${isModelLoaded}<br>
            Hovering: ${isHoveringInteractive}<br>
            Eating: ${isEatingMode}<br>
            FlyGroup: ${flyGroup ? (flyGroup.visible ? 'VISIBLE' : 'HIDDEN') : 'null'}<br>
            FoldGroup: ${foldGroup ? (foldGroup.visible ? 'VISIBLE' : 'HIDDEN') : 'null'}
        `;
    }

// 注入煙霧效果所需的 CSS 樣式
const smokeStyle = document.createElement('style');
smokeStyle.textContent = `
@keyframes inkSmokeSplat {
    0% {
        transform: translate(0, 0) scale(0.1) rotate(0deg);
        opacity: 0.85;
    }
    10% {
        opacity: 0.7;
    }
    100% {
        transform: translate(var(--dx), var(--dy)) scale(var(--scale)) rotate(var(--rot));
        opacity: 0;
    }
}
.smoke-particle {
    position: absolute;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(50, 46, 42, 0.75) 0%, rgba(30, 28, 25, 0) 70%);
    filter: blur(8px);
    pointer-events: none;
    transform-origin: center center;
    will-change: transform, opacity;
}
`;
document.head.appendChild(smokeStyle);

// ═══════════════════════════════════════════════════════════
// 2. Renderer + Scene + Camera
// ═══════════════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);   // 完全透明背景

const scene  = new THREE.Scene();
const FOV    = 45;
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, 500);
camera.position.z = 10;

// 預先計算：滑鼠座標 → 世界座標的映射係數
function computeWorldHalf() {
    const halfH = Math.tan((FOV * Math.PI / 180) / 2) * camera.position.z;
    const halfW = halfH * camera.aspect;
    return { halfH, halfW };
}
let { halfH: worldHalfH, halfW: worldHalfW } = computeWorldHalf();

// ═══════════════════════════════════════════════════════════
// 3. 打光
// ═══════════════════════════════════════════════════════════
scene.add(new THREE.AmbientLight(0xffffff, 1.4));

const sun = new THREE.DirectionalLight(0xfff8e8, 1.0);
sun.position.set(2, 5, 4);
scene.add(sun);

const fill = new THREE.DirectionalLight(0xd0e8ff, 0.5);
fill.position.set(-3, -1, 2);
scene.add(fill);

// ═══════════════════════════════════════════════════════════
// 4. 昆蟲主群組 + 狀態
// ═══════════════════════════════════════════════════════════
const bugGroup = new THREE.Group();
bugGroup.rotation.order = 'YXZ'; // 設定旋轉順序為 YXZ，優先處理偏航 (Y) 再處理俯仰 (X)，以防側傾與 gimbal lock
scene.add(bugGroup);

let flyGroup, foldGroup; // 飛行與收翅的獨立子群組

// 游標跟隨狀態（世界座標）
let mouseWorldX  = 0;
let mouseWorldY  = 0;
let curX = 0, curY = 0;          // 平滑後的位置

// 偏航（Yaw / Y 軸旋轉）
// 預設停止時為 0度
let baseYaw    = 0;
let angleOffset = 0;       // 按右鍵時會切換為 Math.PI (180度反過來)
let targetYaw   = 0;
let currentYaw  = 0;

// 翻滾（Roll / Z 軸旋轉，懸停在按鈕時為 180度/Math.PI）
let targetRoll  = 0;
let currentRoll = 0;

// 俯仰（Pitch / X 軸旋轉，極限值）
const PITCH_MAX  = 0.18;          // ≈ 10°
let targetPitch  = 0;
let currentPitch = 0;

// 上一幀的滑鼠螢幕座標，用於計算方向
let prevScreenX = -1;
let prevScreenY = -1;

// 偵測停頓狀態
let lastMoveTime = performance.now();

// 偵測是否懸停在可點擊元素上 (nav-link, btn-request, a, button)
let isHoveringInteractive = false;
let lastHoverState = null; // 用於控制台切換狀態只打印一次的快取變數

// 翅膀驅動資料
// 翅膀驅動資料
const wingAnimData = [];   // [{ pivot, isRight, phase, freq, ampZ, ampX }]

// ═══════════════════════════════════════════════════════════
// 4.5 雙翅尖飛機拉線軌跡 (Double Contrails / Vapor Trails)
// ═══════════════════════════════════════════════════════════
// 動態產生半透明的軟霧漸層紋理
function createVaporTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    grad.addColorStop(0, 'rgba(35, 33, 30, 0.72)');      // 深碳灰色中心 (水墨感)
    grad.addColorStop(0.35, 'rgba(35, 33, 30, 0.35)');   // 漸薄
    grad.addColorStop(1, 'rgba(240, 235, 224, 0)');      // 融入宣紙色
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}

const maxParticles = 200; // 提高粒子池上限以支援密集的拉線
const particlePool = [];
const vaporTexture = createVaporTexture();
const particleGeo = new THREE.PlaneGeometry(0.12, 0.12); // 放大拉線厚度，使其更為明顯

for (let i = 0; i < maxParticles; i++) {
    const mat = new THREE.MeshBasicMaterial({
        map: vaporTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        opacity: 0
    });
    const mesh = new THREE.Mesh(particleGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    particlePool.push({
        mesh,
        mat,
        age: 0,
        maxAge: 0,
        baseScale: 1
    });
}

function spawnContrailParticle(x, y) {
    // 尋找閒置中的粒子
    const p = particlePool.find(item => !item.mesh.visible);
    if (!p) return;

    p.mesh.position.set(x, y, -0.015); // 略低於昆蟲，防止遮擋
    p.mesh.visible = true;
    p.mat.opacity = 0.7; // 提高初始不透明度
    p.age = 0;
    p.maxAge = 40 + Math.random() * 25; // 40 - 65 幀壽命，呈現中等長度的拖尾
    p.baseScale = 0.5 + Math.random() * 0.4;
    p.mesh.scale.setScalar(p.baseScale);
}

// ═══════════════════════════════════════════════════════════
// 5. 滑鼠與觸控追蹤 (支援多螢幕絕對定位及煙霧特效點座標)
// ═══════════════════════════════════════════════════════════
let lastClientX = window.innerWidth / 2;
let lastClientY = window.innerHeight / 2;

window.addEventListener('mousemove', (e) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;

    // 螢幕 → 世界座標
    mouseWorldX = ((e.clientX / window.innerWidth)  * 2 - 1) *  worldHalfW;
    mouseWorldY = ((e.clientY / window.innerHeight) * 2 - 1) * -worldHalfH;

    const dx = e.clientX - prevScreenX;
    const dy = e.clientY - prevScreenY;

    // 只要有移動就更新時間戳記
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        lastMoveTime = performance.now();
    }

    // 僅在明確水平移動時更新偏航，避免垂直移動時誤觸
    if (Math.abs(dx) > 2) {
        // 修正反向：
        // 左移 → 面朝左（yaw = 1.5 * Math.PI）
        // 右移 → 面朝右（yaw = Math.PI / 2）
        baseYaw = dx < 0 ? 1.5 * Math.PI : Math.PI / 2;
        targetYaw = baseYaw + angleOffset;
    }

    prevScreenX = e.clientX;
    prevScreenY = e.clientY;
}, { passive: true });

// 支援觸控（行動裝置定位）
window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches[0]) {
        lastClientX = e.touches[0].clientX;
        lastClientY = e.touches[0].clientY;
        mouseWorldX = ((lastClientX / window.innerWidth)  * 2 - 1) *  worldHalfW;
        mouseWorldY = ((lastClientY / window.innerHeight) * 2 - 1) * -worldHalfH;
    }
}, { passive: true });

// ═══════════════════════════════════════════════════════════
// 5.2 懸停偵測 (偵測可點擊元素以切換 -90 度趴在上面的狀態)
// ═══════════════════════════════════════════════════════════
window.addEventListener('mouseover', (e) => {
    const clickable = e.target.closest('a, button, .nav-link, .btn-request, [role="button"], .work-card');
    if (clickable) {
        // 排除大圖彈窗內的所有按鈕/互動元素，避免在彈窗中閱讀時干擾
        // 允許作品卡片 (.work-card) 與過濾按鈕 (.filter-btn) 觸發懸停趴下效果
        if (clickable.closest('.modal')) {
            isHoveringInteractive = false;
            return;
        }
        isHoveringInteractive = true;
        console.log('[BugCursor] Mouse over interactive element:', clickable.tagName, clickable.className || '(no class)');
    } else {
        isHoveringInteractive = false;
    }
});

// ═══════════════════════════════════════════════════════════
// 5.5 右鍵點擊切換方向 (Math.PI 反過來)
// ═══════════════════════════════════════════════════════════
window.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // 阻止瀏覽器選單彈出
    angleOffset = angleOffset === 0 ? Math.PI : 0;
    targetYaw = baseYaw + angleOffset; // 立即觸發平滑翻轉
});

// ═══════════════════════════════════════════════════════════
// 5.6 點擊選單 (nav-link) 觸發吃蟲與網頁轉場效果
// ═══════════════════════════════════════════════════════════
let isEatingMode = false;
let isRespawning = false;
let isModelLoaded = false; // 標記 3D 模型是否已載入完成
let eatProgress = 0;
let respawnProgress = 0;
let eatStartX = 0, eatStartY = 0;
// 守宮嘴巴張開的世界座標（中心點），使用者可視實際微調
const mouthWorldPos = new THREE.Vector3(0, 0.28, 0);
let transitionTargetHref = '';

window.addEventListener('click', (e) => {
    // 只有點擊 nav-link 這類導覽連結時才會發生吃蟲與轉場
    const navLink = e.target.closest('.nav-link, .btn-request');
    if (!navLink) return;

    e.preventDefault();
    
    // 若已經被咬食、正在被吸入中或正在轉場中，則跳過
    if (window.isBugEaten || isEatingMode || isRespawning) return;

    transitionTargetHref = navLink.getAttribute('href') || '#';

    // 檢查目前頁面是否含有守宮影片背景，若無（例如在 portfolio.html），則不執行咬食與縮放，改行純黑幕漸變跳轉
    const hasLizard = document.getElementById('bg-video') !== null;
    if (!hasLizard) {
        window.isBugEaten = true;
        const overlay = document.querySelector('.transition-overlay');
        if (overlay) {
            overlay.classList.add('active');
        }
        setTimeout(() => {
            // 如果是真實連結，則跳轉；若是測試 #，則重新整理頁面或重置
            if (transitionTargetHref !== '#' && !transitionTargetHref.startsWith('javascript:')) {
                window.location.href = transitionTargetHref;
            } else {
                // 還原遮罩，供測試
                if (overlay) overlay.classList.remove('active');
                window.isBugEaten = false;
                if (window.respawnBug) window.respawnBug();
            }
        }, 500);
        return;
    }

    // 啟動轉場與咬食模式
    window.isBugEaten = true;
    isEatingMode = true;
    eatProgress = 0;
    eatStartX = curX;
    eatStartY = curY;

    // 啟動 CSS 畫面縮放與 UI 隱藏
    document.body.classList.add('transition-active');
});

// 註冊給 script.js 呼叫的跳轉網址 Getter
window.getTransitionHref = function () {
    return transitionTargetHref;
};

// 創建煙霧粒子特效
function createSmokePuff(x, y) {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = x + 'px';
    container.style.top = y + 'px';
    container.style.width = '0px';
    container.style.height = '0px';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '9999999'; // 確保煙霧高於所有元素
    document.body.appendChild(container);

    const particleCount = 8;
    for (let i = 0; i < particleCount; i++) {
        const p = document.createElement('div');
        p.className = 'smoke-particle';
        
        // 隨機尺寸 (30px 到 70px)
        const size = 30 + Math.random() * 40;
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.left = -(size/2) + 'px';
        p.style.top = -(size/2) + 'px';
        
        // 隨機擴散運動
        const angle = Math.random() * Math.PI * 2;
        const distance = 25 + Math.random() * 45;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance;
        const scale = 2.0 + Math.random() * 1.8;
        const rot = (Math.random() - 0.5) * 240;
        const duration = 700 + Math.random() * 400; // 700ms 到 1100ms
        
        p.style.setProperty('--dx', dx + 'px');
        p.style.setProperty('--dy', dy + 'px');
        p.style.setProperty('--scale', scale);
        p.style.setProperty('--rot', rot + 'deg');
        
        p.style.animation = `inkSmokeSplat ${duration}ms cubic-bezier(0.1, 0.8, 0.3, 1) forwards`;
        
        container.appendChild(p);
    }
    
    // 自動清理
    setTimeout(() => {
        container.remove();
    }, 1200);
}

// 註冊全域復活昆蟲函式
window.respawnBug = function () {
    // 觸發寫意水墨煙霧特效
    createSmokePuff(lastClientX, lastClientY);

    isRespawning = true;
    respawnProgress = 0;
    bugGroup.visible = true;
    // 瞬間將平滑跟隨位置移到目前滑鼠位置，防止從中央跳躍
    curX = mouseWorldX;
    curY = mouseWorldY;
    bugGroup.position.set(curX, curY, 0);
    bugGroup.scale.set(0, 0, 0);
    window.isBugEaten = false;
};

// ═══════════════════════════════════════════════════════════
// 6. 載入 FBX
// ═══════════════════════════════════════════════════════════
const loader = new FBXLoader();
const BASE_URL = '/守宮/3D%20BUG/';

// 手動載入貼圖以防止路徑解析與編碼問題
const texLoader = new THREE.TextureLoader();
const basecolorMap = texLoader.load('/守宮/3D%20BUG/beetle_3d_model_basecolor.JPEG');
const normalMap = texLoader.load('/守宮/3D%20BUG/beetle_3d_model_normal.JPEG');
basecolorMap.colorSpace = THREE.SRGBColorSpace;

let   loadedCnt  = 0;
const fbxObjs    = { body: null, w1: null, w2: null, fold: null };

function onFbxLoaded(key, fbx) {
    fbxObjs[key] = fbx;
    loadedCnt++;
    console.log(`[BugCursor] FBX loaded: ${key} (${loadedCnt}/4)`);

    // 列出每個 mesh 的名稱
    fbx.traverse(c => {
        if (c.isMesh) {
            console.log(`  mesh name: "${c.name || '(unnamed)'}"`);
        }
    });

    if (loadedCnt === 4) buildInsect();
}

loader.load(BASE_URL + 'A01.fbx',
    fbx => onFbxLoaded('body', fbx),
    undefined,
    err => console.error('[BugCursor] A01 load error:', err)
);
loader.load(BASE_URL + 'A02.fbx',
    fbx => onFbxLoaded('w1', fbx),
    undefined,
    err => console.error('[BugCursor] A02 load error:', err)
);
loader.load(BASE_URL + 'A03.fbx',
    fbx => onFbxLoaded('w2', fbx),
    undefined,
    err => console.error('[BugCursor] A03 load error:', err)
);
loader.load(BASE_URL + 'A04.fbx',
    fbx => onFbxLoaded('fold', fbx),
    undefined,
    err => console.error('[BugCursor] A04 load error:', err)
);

// ═══════════════════════════════════════════════════════════
// 7. 組裝昆蟲：縮放、對齊、識別翅膀、建立翅根軸
// ═══════════════════════════════════════════════════════════
function buildInsect() {
    try {
        const body = fbxObjs.body;
        const w1   = fbxObjs.w1;
        const w2   = fbxObjs.w2;
        const fold = fbxObjs.fold;

        // ── 7.0 暫時重置 bugGroup 的旋轉、位置與縮放，防止 BBox 在載入時受滑鼠動畫影響而偏移 ──
        const savedPos   = bugGroup.position.clone();
        const savedRot   = bugGroup.rotation.clone();
        const savedScale = bugGroup.scale.clone();
        bugGroup.position.set(0, 0, 0);
        bugGroup.rotation.set(0, 0, 0);
        bugGroup.scale.set(1, 1, 1);
        bugGroup.updateMatrixWorld(true);

        // ── 7.05 套用手動載入的貼圖與材質（設定為雙面渲染）──
        const insectMaterial = new THREE.MeshStandardMaterial({
            map: basecolorMap,
            normalMap: normalMap,
            roughness: 0.6,
            metalness: 0.2,
            side: THREE.DoubleSide
        });

        [body, w1, w2, fold].forEach(obj => {
            obj.traverse(child => {
                if (child.isMesh) {
                    child.material = insectMaterial;
                }
            });
        });

        // ── 7.1 計算身體原始大小，推導縮放比例 ──────────────
        // 先把 body 暫時加入 bugGroup 以便計算 world bbox
        bugGroup.add(body);
        bugGroup.updateMatrixWorld(true);

        const bodyBBoxOrig = new THREE.Box3().setFromObject(body);
        const bodySizeOrig = bodyBBoxOrig.getSize(new THREE.Vector3());
        const bodyMaxDim   = Math.max(bodySizeOrig.x, bodySizeOrig.y, bodySizeOrig.z);

        // 目標大小：約螢幕 5% 高度的世界單位（作為游標適當大小）
        const TARGET_SIZE  = worldHalfH * 0.13;  // ~0.13x world half-height ≈ 40-60px
        const scaleFactor  = TARGET_SIZE / bodyMaxDim;

        const bodyCenterOrig = bodyBBoxOrig.getCenter(new THREE.Vector3());

        console.log(`[BugCursor] bodyMaxDim=${bodyMaxDim.toFixed(3)}, scaleFactor=${scaleFactor.toFixed(5)}, TARGET_SIZE=${TARGET_SIZE.toFixed(3)}`);

        // 移除暫時加入的 body
        bugGroup.remove(body);

        // ── 7.2 套用統一縮放與置中 ────────────────────────────
        // 身體、翅膀、收翅模型都從 Blender 同一場景匯出，共享座標系
        // 套用相同縮放 + 偏移即可對齊
        const offset = bodyCenterOrig.clone().multiplyScalar(-scaleFactor);  // 置中偏移

        [body, w1, w2, fold].forEach(obj => {
            obj.scale.setScalar(scaleFactor);
            obj.position.copy(offset);
        });

        // 建立飛行與收翅的子群組
        flyGroup = new THREE.Group();
        foldGroup = new THREE.Group();
        bugGroup.add(flyGroup);
        bugGroup.add(foldGroup);

        // 將各自模型分配至對應組別
        flyGroup.add(body);
        flyGroup.add(w1);
        flyGroup.add(w2);
        foldGroup.add(fold);

        // 預設飛行顯示，收翅隱藏
        flyGroup.visible = true;
        foldGroup.visible = false;

        flyGroup.updateMatrixWorld(true);
        foldGroup.updateMatrixWorld(true);

        // ── 7.3 識別左右翅膀（A02.fbx 固定為左翅，A03.fbx 固定為右翅）──
        const leftWing   = w1; // A02.fbx
        const rightWing  = w2; // A03.fbx
        const leftLabel  = 'A02';
        const rightLabel = 'A03';

        console.log(`[BugCursor] 翅膀載入定位完成: 左翅: ${leftLabel}, 右翅: ${rightLabel}`);

        // ── 7.4 計算翅根位置並建立 pivot group ───────────────
        function makePivotGroup(wingObj, isRight) {
            const bbox    = new THREE.Box3().setFromObject(wingObj);
            const center  = bbox.getCenter(new THREE.Vector3());

            // 右翅：min.x 那側（最左邊）最近 body；左翅：max.x 那側
            const rootX   = isRight ? bbox.min.x : bbox.max.x;
            const rootPos = new THREE.Vector3(rootX, center.y, center.z);

            console.log(`[BugCursor] ${isRight ? '右' : '左'}翅 rootPos =`,
                rootPos.toArray().map(v => v.toFixed(3)));

            // 建立 pivot group，放在翅根位置
            const pivot = new THREE.Group();
            pivot.position.copy(rootPos);
            flyGroup.add(pivot);

            // 把 wingObj 從 flyGroup 移到 pivot，更新 position 以相對 pivot
            flyGroup.remove(wingObj);
            wingObj.position.sub(rootPos);   // 在 flyGroup local space 重新計算相對位置
            pivot.add(wingObj);

            return pivot;
        }

        const rightPivot = makePivotGroup(rightWing, true);
        const leftPivot  = makePivotGroup(leftWing,  false);

        // ── 7.5 登記翅膀動畫資料（相位差讓效果更自然）─────
        wingAnimData.push({
            pivot:   rightPivot,
            isRight: true,
            freq:    20,           // 振翅頻率 Hz
            ampZ:    0.55,         // 主振幅（Z 軸傾斜 = 俯視時上下）
            ampX:    0.08,         // 次振幅（X 軸前後）
            phase:   0             // 基準相位
        });
        wingAnimData.push({
            pivot:   leftPivot,
            isRight: false,
            freq:    20,
            ampZ:    0.55,
            ampX:    0.08,
            phase:   0.18          // 小相位差讓雙翅略有不同步感
        });

        // ── 7.6 恢復 bugGroup 載入前的旋轉與位置 ──
        bugGroup.position.copy(savedPos);
        bugGroup.rotation.copy(savedRot);
        bugGroup.scale.copy(savedScale);
        bugGroup.updateMatrixWorld(true);

        isModelLoaded = true; // 模型載入完成
        console.log('[BugCursor] ✅ 昆蟲組裝完成，共', bugGroup.children.length, '個子節點');
    } catch (err) {
        console.error('[BugCursor] Error building insect:', err);
        const errDiv = document.createElement('div');
        errDiv.style.position = 'fixed';
        errDiv.style.bottom = '10px';
        errDiv.style.right = '10px';
        errDiv.style.background = 'red';
        errDiv.style.color = 'white';
        errDiv.style.padding = '15px';
        errDiv.style.fontFamily = 'monospace';
        errDiv.style.fontSize = '12px';
        errDiv.style.zIndex = '999999';
        errDiv.innerText = '[BugCursor Build Error] ' + err.message + '\nStack: ' + err.stack;
        document.body.appendChild(errDiv);
    }
}

// ═══════════════════════════════════════════════════════════
// 8. 動畫迴圈
// ═══════════════════════════════════════════════════════════
const LERP_POS  = 0.10;   // 位置跟隨速度（越大越快）
const LERP_ROT  = 0.07;   // 旋轉跟隨速度

let t0 = performance.now();

function animate() {
    requestAnimationFrame(animate);
    const t = (performance.now() - t0) / 1000;  // 秒

    // 依據懸停狀態，動態切換飛行 (A01+A02+A03) 與收翅 (A04) 模型
    if (isModelLoaded) {
        if (isHoveringInteractive && !isEatingMode) {
            if (lastHoverState !== true) {
                console.log('[BugCursor] State change: Hovering -> Show foldGroup (A04), Hide flyGroup (A01+A02+A03)');
                lastHoverState = true;
            }
            flyGroup.visible = false;
            foldGroup.visible = true;
        } else {
            if (lastHoverState !== false) {
                console.log('[BugCursor] State change: Flying -> Show flyGroup (A01+A02+A03), Hide foldGroup (A04)');
                lastHoverState = false;
            }
            flyGroup.visible = true;
            foldGroup.visible = false;
        }
    }

    // 8.1 位置平滑跟隨 與 咬食 / 復活動畫
    if (isEatingMode) {
        eatProgress += 0.022; // 降速：約 45 幀 (約 750ms) 飛向嘴巴，動作更滑順不突兀
        if (eatProgress > 1.0) eatProgress = 1.0;

        // 磁吸吸入：二次方加速 (Ease-in)
        const tEase = eatProgress * eatProgress;
        curX = eatStartX + (mouthWorldPos.x - eatStartX) * tEase;
        curY = eatStartY + (mouthWorldPos.y - eatStartY) * tEase;

        // 縮小
        bugGroup.scale.setScalar(1.0 - eatProgress);

        if (eatProgress >= 1.0) {
            isEatingMode = false;
            bugGroup.visible = false;
            
            // 啟動全螢幕黑幕轉場遮罩
            const overlay = document.querySelector('.transition-overlay');
            if (overlay) {
                overlay.classList.add('active');
            }

            // 觸發播放守宮吃蟲影片
            if (window.playGeckoEat) {
                window.playGeckoEat();
            }

            // ── 100% 避免首頁轉場卡死黑屏的保底跳轉定時器 ──
            if (transitionTargetHref !== '#' && !transitionTargetHref.startsWith('javascript:')) {
                setTimeout(() => {
                    // 如果這時還在首頁（代表 ended 事件可能因為瀏覽器限制未成功觸發跳轉），則強行跳轉
                    if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname.endsWith('網站2/')) {
                        window.location.href = transitionTargetHref;
                    }
                }, 1800); // 1.8 秒保底，給足咬食影片播映時間
            }
        }
    } else if (isRespawning) {
        respawnProgress += 0.025; // 40 幀 (約 660ms) 更加平滑緩緩浮現
        if (respawnProgress > 1.0) respawnProgress = 1.0;

        // 正常跟隨
        curX += (mouseWorldX - curX) * LERP_POS;
        curY += (mouseWorldY - curY) * LERP_POS;

        // 漸漸放大 (使用 smoothstep 提供極致平滑的 S 曲線進入動畫)
        const scaleVal = THREE.MathUtils.smoothstep(respawnProgress, 0, 1);
        bugGroup.scale.setScalar(scaleVal);

        if (respawnProgress >= 1.0) {
            isRespawning = false;
        }
    } else if (!window.isBugEaten) {
        // 正常跟隨滑鼠
        curX += (mouseWorldX - curX) * LERP_POS;
        curY += (mouseWorldY - curY) * LERP_POS;
        bugGroup.scale.setScalar(1.0);
    }

    // 8.2 懸浮呼吸感（輕微 Y 波動）
    // 當被咬食消失時，我們停止呼吸跳動
    const hover = window.isBugEaten ? 0 : Math.sin(t * 2.8) * 0.04;
    const bugYWithHover = curY + hover;

    bugGroup.position.set(curX, bugYWithHover, 0);

    // 8.25 計算雙翅尖端的世界座標以進行飛機拉線
    // 昆蟲翼展約 0.35 個世界單位，兩側翅尖偏置約為 0.16
    const leftTipX  = curX + Math.cos(currentYaw + Math.PI / 2) * 0.16;
    const leftTipY  = bugYWithHover + Math.sin(currentYaw + Math.PI / 2) * 0.16;
    const rightTipX = curX + Math.cos(currentYaw - Math.PI / 2) * 0.16;
    const rightTipY = bugYWithHover + Math.sin(currentYaw - Math.PI / 2) * 0.16;

    // 僅在 3D 模型載入就緒、飛行中、昆蟲可見且正在運動時才生成拉線軌跡，避免隱藏、加載中或收翅懸停時產生幽靈軌跡
    if (isModelLoaded && bugGroup.visible && !isHoveringInteractive && window.lastLeftTipX !== undefined) {
        const dist = Math.hypot(leftTipX - window.lastLeftTipX, leftTipY - window.lastLeftTipY);
        // 若移動距離大於閾值，在前後幀路徑上線性插值插滿粒子，形成不斷裂的拉線效果
        if (dist > 0.004) {
            const steps = Math.min(8, Math.ceil(dist / 0.008));
            for (let i = 1; i <= steps; i++) {
                const ratio = i / steps;
                const lx = window.lastLeftTipX + (leftTipX - window.lastLeftTipX) * ratio;
                const ly = window.lastLeftTipY + (leftTipY - window.lastLeftTipY) * ratio;
                const rx = window.lastRightTipX + (rightTipX - window.lastRightTipX) * ratio;
                const ry = window.lastRightTipY + (rightTipY - window.lastRightTipY) * ratio;
                spawnContrailParticle(lx, ly);
                spawnContrailParticle(rx, ry);
            }
        }
    }
    window.lastLeftTipX  = leftTipX;
    window.lastLeftTipY  = leftTipY;
    window.lastRightTipX = rightTipX;
    window.lastRightTipY = rightTipY;

    // 偵測滑鼠停頓：若超過 200 毫秒沒移動，自動回正（Y軸為 0度）
    if (performance.now() - lastMoveTime > 200) {
        baseYaw = 0;
    }
    
    // 如果懸停在按鈕上，Y軸固定為 0度
    if (isHoveringInteractive) {
        targetYaw = 0 + angleOffset;
    } else {
        targetYaw = baseYaw + angleOffset;
    }

    // 8.3 偏航（Yaw）— 只圍繞 Y 軸，取最短角路徑
    let yawDiff = targetYaw - currentYaw;
    if (yawDiff >  Math.PI) yawDiff -= 2 * Math.PI;
    if (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
    currentYaw += yawDiff * LERP_ROT;

    // 8.4 俯仰（Pitch）與翻滾（Roll）— 動態設定
    // 1) 懸停在可點擊元素上：X 軸角度為 -90 度 (-Math.PI / 2), Z 軸為 180 度 (Math.PI)
    // 2) 靜止時：X 軸角度為 0 度，Z 軸為 0 度
    // 3) 一般運動時：X 軸角度為 20 度 (20 * Math.PI / 180)，Z 軸為 0 度
    const isStopped = (performance.now() - lastMoveTime > 200);
    
    if (isHoveringInteractive) {
        targetPitch = -Math.PI / 2;
        targetRoll  = Math.PI;
    } else {
        targetRoll  = 0;
        if (isStopped) {
            targetPitch = 0;
        } else {
            targetPitch = 20 * Math.PI / 180;
        }
    }

    // 使用較快的插值速度讓旋轉回饋更即時
    currentPitch += (targetPitch - currentPitch) * 0.12;
    currentRoll  += (targetRoll - currentRoll) * 0.12;

    // 8.5 套用旋轉（X 軸 = currentPitch, Y 軸 = currentYaw, Z 軸 = currentRoll）
    bugGroup.rotation.set(currentPitch, currentYaw, currentRoll);

    // 8.6 翅膀振翅（每片翅膀獨立旋轉軸）
    for (const wd of wingAnimData) {
        // 如果正在被吸入嘴巴（掙扎中），振翅頻率變為 2.5 倍
        const speedMultiplier = isEatingMode ? 2.5 : 1.0;
        const wave = Math.sin(t * Math.PI * 2 * wd.freq * speedMultiplier + wd.phase);
        // 移除手動鏡像負號（FBX 已內建鏡像座標），使雙翅對稱上下振動
        wd.pivot.rotation.z = wave * wd.ampZ;
        // X 旋轉 = 翅膀輕微的前後扭動
        wd.pivot.rotation.x = wave * wd.ampX;
        // Y 旋轉 永遠為 0
        wd.pivot.rotation.y = 0;
    }

    // 8.7 更新飛機拉線軌跡粒子
    for (const p of particlePool) {
        if (p.mesh.visible) {
            p.age++;
            const progress = p.age / p.maxAge;
            
            // 飛機凝結尾特性：隨時間線條收縮變窄 (1.0 -> 0.15)
            const scale = p.baseScale * (1.0 - progress * 0.85);
            p.mesh.scale.setScalar(scale);

            // 漸漸淡出
            p.mat.opacity = 0.7 * (1.0 - progress);

            if (p.age >= p.maxAge) {
                p.mesh.visible = false;
            }
        }
    }

    updateDebugPanel();
    renderer.render(scene, camera);
}
animate();

// ═══════════════════════════════════════════════════════════
// 9. 視窗 resize 處理
// ═══════════════════════════════════════════════════════════
    window.addEventListener('resize', () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        const wh = computeWorldHalf();
        worldHalfH = wh.halfH;
        worldHalfW = wh.halfW;
    });
}
