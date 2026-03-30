/**
 * Auto-Eval3D — Frontend Application
 * 
 * Orchestrates:
 * 1. World generation via backend proxy → Marble API
 * 2. 3D Gaussian Splat rendering via SparkJS + THREE.js
 * 3. Automated 4-way camera orbit and screenshot capture
 * 4. VLM evaluation via backend proxy → Gemini 2.5 Pro
 * 5. Results display and history management
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SplatMesh } from "@sparkjsdev/spark";

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════
const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  splatMesh: null,
  animationId: null,
  isRunning: false,
  capturedImages: [],
  currentSpzUrl: null,
  currentOperationId: null,
  historyPage: 1,
  sceneCenter: new THREE.Vector3(),
};

// ═══════════════════════════════════════════════════════
// DOM References
// ═══════════════════════════════════════════════════════
const els = {
  promptInput: document.getElementById("prompt-input"),
  modelSelect: document.getElementById("model-select"),
  btnGenerate: document.getElementById("btn-generate"),
  viewerContainer: document.getElementById("viewer-container"),
  viewerOverlay: document.getElementById("viewer-overlay"),
  viewerHint: document.getElementById("viewer-hint"),
  statusIndicator: document.getElementById("status-indicator"),
  statusText: document.getElementById("status-text"),
  viewpointsGrid: document.getElementById("viewpoints-grid"),
  scoreEmpty: document.getElementById("score-empty"),
  scoreContent: document.getElementById("score-content"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  historyPagination: document.getElementById("history-pagination"),
  historyPrev: document.getElementById("history-prev"),
  historyNext: document.getElementById("history-next"),
  historyPageInfo: document.getElementById("history-page-info"),
  pipelineProgress: document.getElementById("pipeline-progress"),
  stepGenerate: document.getElementById("step-generate"),
  stepLoad: document.getElementById("step-load"),
  stepCapture: document.getElementById("step-capture"),
  stepEvaluate: document.getElementById("step-evaluate"),
  samplePrompts: document.getElementById("sample-prompts"),
};

// ═══════════════════════════════════════════════════════
// THREE.js Setup
// ═══════════════════════════════════════════════════════
function initThreeJS() {
  const container = els.viewerContainer;
  const w = container.clientWidth;
  const h = container.clientHeight;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x0a0a0f);

  state.camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  state.camera.position.set(0, 0, 3);

  // CRITICAL: preserveDrawingBuffer: true for toDataURL screenshots
  // CRITICAL: antialias: false for SparkJS performance
  state.renderer = new THREE.WebGLRenderer({
    preserveDrawingBuffer: true,
    antialias: false,
    alpha: false,
  });
  state.renderer.setSize(w, h);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // ACES filmic tone mapping — makes Gaussian splats look cinematic
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.0;

  container.insertBefore(state.renderer.domElement, container.firstChild);

  // OrbitControls for interactive 3D viewing (#6)
  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.08;
  state.controls.rotateSpeed = 0.8;
  state.controls.zoomSpeed = 1.0;
  state.controls.minDistance = 0.5;
  state.controls.maxDistance = 50;

  // Resize handler
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(w, h);
  });
  ro.observe(container);

  // Start render loop
  function animate() {
    state.animationId = requestAnimationFrame(animate);
    // CRITICAL: Only update controls when enabled — during capture, the rig
    // manually sets camera.lookAt() which controls.update() would override
    if (state.controls.enabled) {
      state.controls.update();
    }
    state.renderer.render(state.scene, state.camera);
  }
  animate();
}

// ═══════════════════════════════════════════════════════
// Status & Progress Management
// ═══════════════════════════════════════════════════════
function setStatus(text, statusClass = "") {
  els.statusText.textContent = text;
  els.statusIndicator.className = "status-indicator " + statusClass;
}

function setButtonLoading(loading) {
  els.btnGenerate.disabled = loading;
  els.btnGenerate.classList.toggle("loading", loading);
}

function showProgress(show) {
  els.pipelineProgress.style.display = show ? "flex" : "none";
  if (show) {
    // Reset all steps
    [els.stepGenerate, els.stepLoad, els.stepCapture, els.stepEvaluate].forEach(
      (step) => {
        step.className = "progress-step";
        step.querySelector(".progress-step-icon").textContent = "⏳";
      }
    );
  }
}

function setStepStatus(stepEl, status) {
  // status: 'active', 'done', 'error'
  stepEl.className = "progress-step progress-step-" + status;
  const icon = stepEl.querySelector(".progress-step-icon");
  if (status === "active") icon.textContent = "⏳";
  else if (status === "done") icon.textContent = "✅";
  else if (status === "error") icon.textContent = "❌";
}

// ═══════════════════════════════════════════════════════
// SPZ Loading — uses `await splat.initialized` (#2)
// ═══════════════════════════════════════════════════════
async function loadSplatMesh(spzUrl) {
  // Remove and dispose old splat if exists (#7 — GPU memory leak fix)
  if (state.splatMesh) {
    state.scene.remove(state.splatMesh);
    state.splatMesh.dispose();
    state.splatMesh = null;
  }

  setStatus("Loading 3D Gaussian Splat...", "active");

  try {
    const splat = new SplatMesh({ url: spzUrl });

    // Fix COLMAP → THREE.js coordinate mismatch:
    // Marble/COLMAP uses Y-down, THREE.js uses Y-up
    // Rotate 180° around X-axis to flip the scene right-side up
    splat.rotation.x = Math.PI;

    state.scene.add(splat);
    state.splatMesh = splat;

    // Properly await SparkJS initialization instead of fragile polling (#2)
    await splat.initialized;

    // Get bounding box now that splat is fully loaded
    const bbox = splat.getBoundingBox(true);

    if (!bbox || bbox.isEmpty()) {
      throw new Error("Splat loaded but bounding box is empty — possible corrupt SPZ file");
    }

    const size = new THREE.Vector3();
    bbox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    // Marble generates scenes with the natural camera AT the world origin (0,0,0).
    // Using the bbox center is wrong — after the Math.PI X-rotation, Z flips too,
    // so localToWorld produces a displaced center that may point away from the room.
    // Simply use the origin as the standing position, matching how Marble captured it.
    const center = new THREE.Vector3(0, 0, 0);

    // Eye level: slightly below origin (origin is mid-room height in Marble scenes)
    const eyeY = -maxDim * 0.05;
    state.camera.position.set(0, eyeY, 0);

    // Look forward into the scene (-Z after the Math.PI flip = into the room)
    const lookTarget = new THREE.Vector3(0, eyeY, -2);
    state.camera.lookAt(lookTarget);
    state.sceneCenter.copy(center);

    // Update OrbitControls target to look into the scene
    state.controls.target.copy(lookTarget);
    state.controls.minDistance = 0.01;
    state.controls.maxDistance = maxDim * 0.8;
    state.controls.update();

    setStatus("3D world loaded — drag to explore!", "success");
    els.viewerOverlay.classList.add("hidden");
    els.viewerHint.style.display = "inline";

    return { center, maxDim };
  } catch (e) {
    // Clean up on failure
    if (state.splatMesh) {
      state.scene.remove(state.splatMesh);
      state.splatMesh.dispose();
      state.splatMesh = null;
    }
    throw new Error(`Failed to load Gaussian Splat: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// Camera Rig — 4-Way Orbit & Capture
// ═══════════════════════════════════════════════════════
async function captureMultiView(sceneInfo) {
  setStatus("Capturing multi-view perspectives...", "active");
  state.capturedImages = [];

  const { maxDim } = sceneInfo;
  const labels = ["0° Front", "90° Right", "180° Back", "270° Left"];
  const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

  // Temporarily disable controls during capture
  state.controls.enabled = false;

  for (let i = 0; i < 4; i++) {
    const angle = angles[i];

    // Camera at origin eye level (Marble's natural camera position)
    const eyeY = -maxDim * 0.05;
    state.camera.position.set(0, eyeY, 0);

    // Compute look direction for this viewpoint (rotate in place around Y axis)
    const lookX = Math.sin(angle) * 5;
    const lookZ = -Math.cos(angle) * 5;
    const lookTarget = new THREE.Vector3(lookX, eyeY, lookZ);

    // Force camera orientation update
    state.camera.lookAt(lookTarget);
    state.camera.updateProjectionMatrix();
    state.camera.updateMatrixWorld(true);

    // Update controls target (do NOT call controls.update() — controls are disabled
    // during capture and calling update() would apply damping and override lookAt)
    state.controls.target.copy(lookTarget);

    // CRITICAL: Wait for SparkJS WebWorkers to re-sort gaussians for new viewpoint
    await waitFrames(20);

    // Force a clean render with updated camera
    state.renderer.render(state.scene, state.camera);

    // Extra settle time after render for gaussian sorting
    await waitFrames(10);

    // Second render pass to ensure SparkJS has fully settled
    state.renderer.render(state.scene, state.camera);
    await waitFrames(3);

    // Capture screenshot
    const dataUrl = state.renderer.domElement.toDataURL("image/jpeg", 0.85);
    state.capturedImages.push(dataUrl);

    // Update viewpoint grid
    updateViewpointCell(i, dataUrl, labels[i]);

    setStatus(`Captured viewpoint ${i + 1}/4: ${labels[i]}`, "active");
  }

  // Reset camera to origin eye level and re-enable controls
  const resetEyeY = -maxDim * 0.05;
  state.camera.position.set(0, resetEyeY, 0);
  const resetTarget = new THREE.Vector3(0, resetEyeY, -2);
  state.camera.lookAt(resetTarget);
  state.controls.target.copy(resetTarget);
  state.controls.enabled = true;
  state.controls.update();

  setStatus("All viewpoints captured", "success");
  return state.capturedImages;
}

function waitFrames(count) {
  return new Promise((resolve) => {
    let frames = 0;
    // Fallback timeout in case rAF stalls (e.g. tab is hidden/backgrounded)
    const timeout = setTimeout(resolve, count * 32 + 500);
    function tick() {
      frames++;
      if (frames >= count) {
        clearTimeout(timeout);
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

function updateViewpointCell(index, dataUrl, label) {
  const cell = document.getElementById(`vp-${index}`);
  cell.innerHTML = `
    <img src="${dataUrl}" alt="Viewpoint ${label}" />
    <span class="viewpoint-label">${label}</span>
  `;
  cell.classList.add("captured", "scale-in");
}

function resetViewpoints() {
  const labels = ["0° Front", "90° Right", "180° Back", "270° Left"];
  for (let i = 0; i < 4; i++) {
    const cell = document.getElementById(`vp-${i}`);
    cell.innerHTML = `
      <div class="viewpoint-placeholder">
        <div class="viewpoint-placeholder-icon">📷</div>
        ${labels[i]}
      </div>
    `;
    cell.classList.remove("captured", "scale-in");
  }
}

// ═══════════════════════════════════════════════════════
// High-Fidelity Polling (#4 — fixed)
// ═══════════════════════════════════════════════════════
async function pollHighFidelityStatus(operationId) {
  const maxAttempts = 180; // 180 * 2s = 6 min max
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));

    const resp = await fetch(`/api/status/${operationId}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `Status poll failed: ${resp.status}`);
    }

    const data = await resp.json();

    if (data.status === "completed") {
      return data;
    }

    // Update progress text
    const desc = data.progress_description || "Generating...";
    setStatus(`High-fidelity: ${desc}`, "active");
  }

  throw new Error("High-fidelity generation timed out after 6 minutes");
}

// ═══════════════════════════════════════════════════════
// VLM Evaluation
// ═══════════════════════════════════════════════════════
async function evaluateScene(prompt, operationId, spzUrl, images) {
  setStatus("Gemini evaluating spatial coherence...", "active");

  const response = await fetch("/api/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation_id: operationId,
      spz_url: spzUrl,
      prompt: prompt,
      images: images,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Evaluation failed: ${response.status}`);
  }

  return await response.json();
}

// ═══════════════════════════════════════════════════════
// Score Display
// ═══════════════════════════════════════════════════════
function displayScore(result) {
  const { score, spatial_thinking, thinking, answer } = result;

  // Score class
  const scoreClass = getScoreClass(score);
  const scoreLabel = getScoreLabel(score);

  // SVG ring
  const circumference = 2 * Math.PI * 32;
  const filled = (score / 10) * circumference;
  const offset = circumference - filled;

  els.scoreEmpty.style.display = "none";
  els.scoreContent.style.display = "block";
  els.scoreContent.innerHTML = `
    <div class="score-display fade-in">
      <div class="score-ring">
        <svg width="80" height="80" viewBox="0 0 80 80">
          <circle class="ring-bg" cx="40" cy="40" r="32" />
          <circle class="ring-fill ring-${scoreClass}"
            cx="40" cy="40" r="32"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}" />
        </svg>
        <div class="score-number score-${scoreClass}">${score}</div>
      </div>
      <div class="score-meta">
        <div class="score-title">Spatial Coherence Score</div>
        <span class="score-label score-bg-${scoreClass}">${scoreLabel}</span>
      </div>
    </div>
    <div class="thinking-sections">
      ${makeThinkingSection("🔍 Spatial Pre-Alignment", spatial_thinking, true)}
      ${makeThinkingSection("🧠 Reasoning", thinking, false)}
      ${makeThinkingSection("📋 Final Assessment", answer, true)}
    </div>
  `;

  // Wire up toggle behavior
  document.querySelectorAll(".thinking-header").forEach((header) => {
    header.addEventListener("click", () => {
      header.closest(".thinking-section").classList.toggle("open");
    });
  });
}

function makeThinkingSection(title, content, openByDefault) {
  return `
    <div class="thinking-section${openByDefault ? " open" : ""}">
      <div class="thinking-header">
        ${title}
        <span class="thinking-chevron">▼</span>
      </div>
      <div class="thinking-content">
        <div class="thinking-text">${escapeHtml(content || "No data")}</div>
      </div>
    </div>
  `;
}

function getScoreClass(score) {
  if (score >= 8) return "excellent";
  if (score >= 6) return "good";
  if (score >= 4) return "fair";
  return "poor";
}

function getScoreLabel(score) {
  if (score >= 8) return "Excellent Coherence";
  if (score >= 6) return "Good Coherence";
  if (score >= 4) return "Fair Coherence";
  return "Poor Coherence";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════
// History
// ═══════════════════════════════════════════════════════
async function loadHistory(page = 1) {
  try {
    const resp = await fetch(`/api/evaluations?page=${page}&limit=5`);
    if (!resp.ok) return;
    const data = await resp.json();

    state.historyPage = data.meta.page;

    if (data.data.length === 0) {
      els.historyEmpty.style.display = "block";
      els.historyPagination.style.display = "none";
      return;
    }

    els.historyEmpty.style.display = "none";
    els.historyList.innerHTML = data.data
      .map((ev) => {
        const scoreClass = getScoreClass(ev.score);
        const dateStr = new Date(ev.created_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `
          <li class="history-item fade-in">
            <div class="history-score score-bg-${scoreClass}">${ev.score}</div>
            <div class="history-info">
              <div class="history-prompt">${escapeHtml(ev.prompt)}</div>
              <div class="history-date">${dateStr}</div>
            </div>
          </li>
        `;
      })
      .join("");

    // Pagination
    if (data.meta.total_pages > 1) {
      els.historyPagination.style.display = "flex";
      els.historyPageInfo.textContent = `${data.meta.page} / ${data.meta.total_pages}`;
      els.historyPrev.disabled = data.meta.page <= 1;
      els.historyNext.disabled = data.meta.page >= data.meta.total_pages;
    } else {
      els.historyPagination.style.display = "none";
    }
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

// ═══════════════════════════════════════════════════════
// Main Pipeline
// ═══════════════════════════════════════════════════════
async function runPipeline() {
  if (state.isRunning) return;

  const prompt = els.promptInput.value.trim();
  if (!prompt) {
    els.promptInput.focus();
    els.promptInput.style.borderColor = "var(--accent-rose)";
    setTimeout(() => {
      els.promptInput.style.borderColor = "";
    }, 2000);
    return;
  }

  const model = els.modelSelect.value;

  state.isRunning = true;
  setButtonLoading(true);
  resetViewpoints();
  showProgress(true);

  try {
    // ── Step 1: Generate ──
    setStepStatus(els.stepGenerate, "active");
    setStatus("Generating 3D world...", "active");

    const genResp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model }),
    });

    if (!genResp.ok) {
      const err = await genResp.json().catch(() => ({}));
      throw new Error(err.detail || `Generation failed: ${genResp.status}`);
    }

    let genData = await genResp.json();

    // Handle high-fidelity async mode (#4 — fixed)
    if (genData.status === "in_progress") {
      setStatus("High-fidelity generation in progress...", "active");
      genData = await pollHighFidelityStatus(genData.operation_id);
    }

    state.currentOperationId = genData.operation_id;
    state.currentSpzUrl = genData.spz_url;

    if (!genData.spz_url) {
      throw new Error("No SPZ URL returned from generation");
    }

    setStepStatus(els.stepGenerate, "done");

    // ── Step 2: Load into viewer ──
    setStepStatus(els.stepLoad, "active");
    const sceneInfo = await loadSplatMesh(genData.spz_url);
    setStepStatus(els.stepLoad, "done");

    // ── Step 3: Multi-view capture ──
    setStepStatus(els.stepCapture, "active");
    const images = await captureMultiView(sceneInfo);
    setStepStatus(els.stepCapture, "done");

    // ── Step 4: Evaluate ──
    setStepStatus(els.stepEvaluate, "active");
    const evalResult = await evaluateScene(
      prompt,
      genData.operation_id,
      genData.spz_url,
      images
    );
    setStepStatus(els.stepEvaluate, "done");

    // ── Step 5: Display results ──
    displayScore(evalResult);
    setStatus(`Evaluation complete — Score: ${evalResult.score}/10`, "success");

    // Refresh history
    await loadHistory(1);
  } catch (err) {
    console.error("Pipeline error:", err);
    setStatus(`Error: ${err.message}`, "error");
    // Mark current step as error
    [els.stepGenerate, els.stepLoad, els.stepCapture, els.stepEvaluate].forEach(
      (step) => {
        if (step.classList.contains("progress-step-active")) {
          setStepStatus(step, "error");
        }
      }
    );
  } finally {
    state.isRunning = false;
    setButtonLoading(false);
  }
}

// ═══════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════
els.btnGenerate.addEventListener("click", runPipeline);

// Allow Ctrl+Enter / Cmd+Enter to trigger
els.promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runPipeline();
  }
});

// Sample prompt buttons (#11)
document.querySelectorAll(".sample-prompt-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    els.promptInput.value = btn.dataset.prompt;
    els.promptInput.focus();
    // Visual feedback
    btn.style.borderColor = "var(--accent-emerald)";
    setTimeout(() => {
      btn.style.borderColor = "";
    }, 500);
  });
});

els.historyPrev.addEventListener("click", () => {
  if (state.historyPage > 1) loadHistory(state.historyPage - 1);
});

els.historyNext.addEventListener("click", () => {
  loadHistory(state.historyPage + 1);
});

// ═══════════════════════════════════════════════════════
// Initialize
// ═══════════════════════════════════════════════════════
initThreeJS();
loadHistory(1);

console.log("✨ Auto-Eval3D initialized — ViewFusion Spatial Coherence Evaluator");
