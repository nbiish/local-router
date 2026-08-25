export function renderLayout(
  title: string,
  bodyHtml: string,
  params: {
    defaultFallbackModelsText: string;
  }
): string {
  function jsString(s: string): string {
    return JSON.stringify(s).replace(/[\u2028\u2029]/g, c => c === '\u2028' ? '\\u2028' : '\\u2029');
  }
  const defaultFallbackModelsTextJs = jsString(params.defaultFallbackModelsText);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} | Local Router</title>
  <style>


        :root {
          color-scheme: light;
          --app-bg: rgb(244, 247, 251);
          --surface: rgb(255, 255, 255);
          --surface-soft: rgb(249, 251, 254);
          --surface-raised: rgb(255, 255, 255);
          --text: rgb(28, 36, 48);
          --muted: rgb(91, 101, 116);
          --border: rgb(214, 224, 236);
          --border-strong: rgb(196, 209, 225);
          --primary: rgb(0, 103, 179);
          --primary-hover: rgb(0, 79, 140);
          --primary-text: rgb(255, 255, 255);
          --primary-soft: rgb(231, 242, 255);
          --secondary-bg: rgb(244, 247, 250);
          --secondary-hover: rgb(232, 238, 246);
          --success-bg: rgb(231, 248, 238);
          --success-text: rgb(31, 122, 61);
          --warning-bg: rgb(255, 243, 221);
          --warning-text: rgb(138, 91, 0);
          --danger-text: rgb(180, 35, 24);
          --log-bg: rgb(15, 23, 42);
          --log-text: rgb(209, 213, 219);
          --shadow: rgba(15, 23, 42, 0.12);
          --focus-ring: rgba(0, 122, 204, 0.18);
        }
        * { box-sizing: border-box; }
        body {
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          max-width: 960px;
          margin: 40px auto;
          padding: 20px;
          background: var(--app-bg);
          color: var(--text);
          transition: background-color 160ms ease, color 160ms ease;
        }
        .card {
          background: var(--surface);
          color: var(--text);
          padding: 20px;
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: 0 8px 24px var(--shadow);
          margin-bottom: 20px;
          transition: background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
        }
        h2, h3, h4, h5 { color: var(--text); }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, textarea, select {
          width: 100%;
          padding: 8px;
          color: var(--text);
          background: var(--surface-raised);
          border: 1px solid var(--border-strong);
          border-radius: 4px;
        }
        input:focus, textarea:focus, select:focus {
          outline: none;
          border-color: var(--primary);
          box-shadow: 0 0 0 3px var(--focus-ring);
        }
        input:disabled { color: var(--muted); background: var(--surface-soft); }
        textarea { min-height: 140px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 13px; }
        button {
          background: var(--primary);
          color: var(--primary-text);
          border: 1px solid transparent;
          padding: 10px 15px;
          border-radius: 4px;
          cursor: pointer;
        }
        button:hover { background: var(--primary-hover); }
        a { color: var(--primary); }
        #message { margin-top: 15px; font-weight: bold; color: var(--success-text); }
        .muted { color: var(--muted); font-size: 14px; }
        .catalog { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 16px; }
        .provider-group { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--surface-soft); }
        .provider-group h3 { margin: 0 0 8px; font-size: 16px; }
        .model-list { list-style: none; padding: 0; margin: 0; }
        .provider-group .model-list { max-height: 360px; overflow-y: auto; padding-right: 4px; }
        .model-list li { padding: 6px 0; border-top: 1px solid var(--border); font-size: 14px; word-break: break-word; }
        .model-list li:first-child { border-top: 0; }
        .curation-provider-search { width: 100%; margin: 0 0 8px; box-sizing: border-box; }
        .catalog-meta { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
        .provider-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: end; margin-top: 16px; }
        .provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 16px; }
        .provider-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--surface-raised); }
        .provider-card.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--focus-ring); }
        .provider-card h4 { margin: 0 0 8px; font-size: 15px; }
        .provider-card .row { margin-top: 10px; }
        .custom-provider-panel { border: 1px dashed var(--border-strong); border-radius: 8px; padding: 14px; margin: 12px 0; background: var(--surface-soft); }
        .endpoint-help { margin: 12px 0; font-size: 13px; }
        .endpoint-help summary { cursor: pointer; font-weight: 600; }
        .endpoint-help table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
        .endpoint-help th, .endpoint-help td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
        .pill.custom { background: var(--warning-bg); color: var(--warning-text); }
        .pill.catalog { background: var(--primary-soft); color: var(--primary); }
        #providerKeySection.hidden { display: none; }
        .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 12px; margin-left: 8px; }
        .status-pill { margin: 8px 0 0; margin-left: 0; }
        .status-pill.configured { background: var(--success-bg); color: var(--success-text); }
        .status-pill.pending { background: var(--warning-bg); color: var(--warning-text); }
        .candidate-status { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; margin-left: 6px; }
        .candidate-status.ready { background: var(--success-bg); color: var(--success-text); }
        .candidate-status.no-key { background: var(--warning-bg); color: var(--warning-text); }
        .candidate-status.unavailable { background: var(--secondary-bg); color: var(--muted); }
        .routing-info-box {
          margin-top: 14px;
          padding: 12px 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface-soft);
          font-size: 13px;
          line-height: 1.55;
        }
        .routing-info-box h4 { margin: 0 0 8px; font-size: 14px; }
        .routing-info-box ul { margin: 8px 0 0 18px; padding: 0; }
        .routing-info-box li { margin: 4px 0; }
        .row-actions { display: flex; gap: 10px; }
        .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .button-secondary { background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-strong); }
        .button-secondary:hover { background: var(--secondary-hover); }
        #message.error { color: var(--danger-text); }
        #message.success { color: var(--success-text); }
        .theme-panel {
          display: grid;
          grid-template-columns: minmax(180px, 0.45fr) 1fr;
          gap: 18px;
          align-items: center;
          margin-bottom: 18px;
          padding: 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface-soft);
        }
        .theme-title { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
        .theme-value { color: var(--muted); font-size: 13px; font-weight: 700; }
        .theme-slider { display: grid; gap: 7px; }
        .theme-slider input[type="range"] { padding: 0; border: 0; accent-color: var(--primary); background: transparent; }
        .theme-scale-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
        .diagnostics-controls { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
        .diagnostics-log {
          margin-top: 12px;
          border-radius: 8px;
          border: 1px solid var(--border-strong);
          background: var(--log-bg);
          color: var(--log-text);
          padding: 12px;
          min-height: 120px;
          max-height: 320px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.45;
        }
        .model-flag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-top: 10px; }
        .flag-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text); }
        .flag-toggle input { width: auto; margin: 0; }
        .provider-group.active { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary-soft); }
        .provider-model-list { margin-top: 14px; border: 1px solid var(--border); border-radius: 8px; overflow-x: hidden; overflow-y: auto; max-height: 360px; }
        .provider-model-item { padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface-raised); }
        .provider-model-item:first-child { border-top: 0; }
        .provider-model-item h5 { margin: 0 0 4px; font-size: 14px; }
        .provider-model-item .meta { font-size: 12px; color: var(--muted); margin: 3px 0; }
        .provider-model-item .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
        .provider-model-item .tag { font-size: 11px; color: var(--primary); background: var(--primary-soft); border-radius: 999px; padding: 2px 7px; }
        .provider-model-item .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
        .provider-model-empty { padding: 10px 12px; font-size: 13px; color: var(--muted); background: var(--surface-soft); }
        .fallback-route-list { margin-top: 14px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .fallback-route-item { padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface-raised); }
        .fallback-route-item:first-child { border-top: 0; }
        .fallback-route-item h4 { margin: 0 0 4px; font-size: 14px; }
        .fallback-route-item .meta { font-size: 12px; color: var(--muted); margin: 3px 0; word-break: break-word; }
        .fallback-route-item .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
        .fallback-route-empty { padding: 10px 12px; font-size: 13px; color: var(--muted); background: var(--surface-soft); }
        .dropdown-search-container { position: relative; }
        .dropdown-search-menu { position: absolute; top: 100%; left: 0; right: 0; max-height: 240px; overflow-y: auto; background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: 4px; z-index: 100; box-shadow: 0 4px 12px var(--shadow); display: none; }
        .dropdown-search-item { padding: 8px 10px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .dropdown-search-item:last-child { border-bottom: 0; }
        .dropdown-search-item:hover, .dropdown-search-item.selected { background: var(--primary-soft); }
        .dropdown-search-item .provider-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--secondary-bg); color: var(--muted); white-space: nowrap; }
        .dropdown-search-item .in-chain-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--success-bg); color: var(--success-text); white-space: nowrap; }
        .model-config-summary { font-size: 10px; margin-left: 6px; white-space: nowrap; }
        .router-candidate-list { margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .router-candidate-item { padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface-raised); display: flex; align-items: center; gap: 10px; }
        .router-candidate-item:first-child { border-top: 0; }
        .router-candidate-item.dragging { opacity: 0.5; background: var(--primary-soft); }
        .router-candidate-item.router-candidate-disabled { opacity: 0.5; background: var(--surface-soft); }
        .router-candidate-item.router-candidate-disabled .candidate-model { text-decoration: line-through; color: var(--muted); }
        .router-candidate-item .candidate-toggle { width: 18px; height: 18px; cursor: pointer; margin: 0; flex-shrink: 0; }
        .router-candidate-item .drag-handle { cursor: grab; color: var(--muted); font-size: 18px; user-select: none; padding: 0 4px; }
        .router-candidate-item .drag-handle:active { cursor: grabbing; }
        .router-candidate-item .candidate-info { flex: 1; min-width: 0; }
        .router-candidate-item .candidate-model { font-size: 14px; font-weight: 600; word-break: break-word; }
        .router-candidate-item .provider-badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); margin-left: 6px; vertical-align: middle; }
        .router-candidate-item .remove-btn { background: none; border: none; color: var(--danger-text); cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 4px; }
        .router-candidate-item .remove-btn:hover { background: var(--secondary-hover); }
        .router-candidate-empty { padding: 10px 12px; font-size: 13px; color: var(--muted); background: var(--surface-soft); }
        @media (max-width: 720px) {
          body { margin: 0 auto; padding: 12px; }
          .theme-panel, .provider-picker { grid-template-columns: 1fr; }
          .catalog-meta { align-items: flex-start; flex-direction: column; }
        }
      
        body {
          margin: 0;
          padding: 0;
          height: 100vh;
          overflow: hidden;
          background: var(--app-bg);
          color: var(--text);
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .layout-container {
          display: flex;
          height: 100vh;
          width: 100vw;
        }
        .sidebar {
          width: 240px;
          background: var(--surface);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          flex-shrink: 0;
        }
        .sidebar-header {
          padding: 20px;
          border-bottom: 1px solid var(--border);
        }
        .sidebar-header h2 {
          margin: 0 0 4px;
          font-size: 18px;
        }
        .sidebar-nav {
          padding: 15px 10px;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 6px;
          overflow-y: auto;
        }
        .nav-link {
          display: block;
          padding: 10px 14px;
          border-radius: 6px;
          color: var(--text);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: background-color 120ms ease;
        }
        .nav-link:hover {
          background: var(--secondary-hover);
        }
        .nav-link.active {
          background: var(--primary);
          color: var(--primary-text);
        }
        .sidebar-footer {
          padding: 15px 20px;
          border-top: 1px solid var(--border);
        }
        .theme-panel-compact {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          font-size: 13px;
        }
        .theme-panel-compact label {
          margin-bottom: 0;
        }
        .theme-panel-compact select {
          width: auto;
          padding: 4px 8px;
        }
        .main-content {
          flex: 1;
          padding: 30px 40px;
          overflow-y: auto;
        }

  </style>
  <script>

        const THEME_STORAGE_KEY = 'local-router-config-color-scheme-scale';
        const LEGACY_THEME_STORAGE_KEY = 'fvs-code-config-color-scheme-scale';
        const THEME_PRESETS = [
          {
            name: 'Light',
            bg: [244, 247, 251],
            surface: [255, 255, 255],
            surfaceSoft: [249, 251, 254],
            surfaceRaised: [255, 255, 255],
            text: [28, 36, 48],
            muted: [91, 101, 116],
            border: [214, 224, 236],
            borderStrong: [196, 209, 225],
            primary: [0, 103, 179],
            primaryHover: [0, 79, 140],
            primaryText: [255, 255, 255],
            primarySoft: [231, 242, 255],
            secondaryBg: [244, 247, 250],
            secondaryHover: [232, 238, 246],
            successBg: [231, 248, 238],
            successText: [31, 122, 61],
            warningBg: [255, 243, 221],
            warningText: [138, 91, 0],
            dangerText: [180, 35, 24],
            logBg: [15, 23, 42],
            logText: [209, 213, 219],
            shadow: [15, 23, 42, 0.12],
            focusRing: [0, 122, 204, 0.18]
          },
          {
            name: 'Balanced',
            bg: [226, 232, 240],
            surface: [245, 248, 252],
            surfaceSoft: [235, 240, 247],
            surfaceRaised: [250, 252, 255],
            text: [30, 41, 59],
            muted: [82, 96, 117],
            border: [187, 199, 216],
            borderStrong: [161, 176, 198],
            primary: [9, 88, 154],
            primaryHover: [7, 70, 125],
            primaryText: [255, 255, 255],
            primarySoft: [219, 237, 255],
            secondaryBg: [232, 238, 246],
            secondaryHover: [220, 229, 240],
            successBg: [218, 244, 229],
            successText: [25, 106, 54],
            warningBg: [255, 238, 207],
            warningText: [128, 78, 0],
            dangerText: [166, 35, 31],
            logBg: [18, 27, 44],
            logText: [218, 224, 234],
            shadow: [15, 23, 42, 0.16],
            focusRing: [15, 112, 191, 0.22]
          },
          {
            name: 'Dark',
            bg: [15, 20, 29],
            surface: [24, 31, 43],
            surfaceSoft: [29, 38, 52],
            surfaceRaised: [32, 42, 57],
            text: [238, 242, 247],
            muted: [177, 187, 201],
            border: [61, 74, 94],
            borderStrong: [82, 98, 122],
            primary: [98, 178, 255],
            primaryHover: [133, 197, 255],
            primaryText: [8, 19, 33],
            primarySoft: [25, 63, 102],
            secondaryBg: [38, 49, 66],
            secondaryHover: [49, 63, 83],
            successBg: [20, 66, 44],
            successText: [124, 222, 162],
            warningBg: [92, 62, 18],
            warningText: [255, 206, 124],
            dangerText: [255, 137, 127],
            logBg: [8, 12, 20],
            logText: [225, 232, 242],
            shadow: [0, 0, 0, 0.32],
            focusRing: [98, 178, 255, 0.26]
          }
        ];

        function clampThemeScale(rawValue) {
          const value = Number.parseInt(String(rawValue), 10);
          if (!Number.isFinite(value)) return 0;
          return Math.max(0, Math.min(100, value));
        }

        function mixNumber(start, end, amount) {
          return Math.round(start + (end - start) * amount);
        }

        function mixColor(start, end, amount) {
          return start.map((channel, index) => {
            const next = end[index];
            return index === 3
              ? Number((channel + (next - channel) * amount).toFixed(3))
              : mixNumber(channel, next, amount);
          });
        }

        function themeAtScale(scale) {
          const clamped = clampThemeScale(scale);
          const lowerIndex = clamped <= 50 ? 0 : 1;
          const upperIndex = clamped <= 50 ? 1 : 2;
          const amount = clamped <= 50 ? clamped / 50 : (clamped - 50) / 50;
          const lower = THEME_PRESETS[lowerIndex];
          const upper = THEME_PRESETS[upperIndex];
          const theme = { name: clamped < 34 ? 'Light' : clamped < 67 ? 'Balanced' : 'Dark' };

          for (const key of Object.keys(lower)) {
            if (key === 'name') continue;
            theme[key] = mixColor(lower[key], upper[key], amount);
          }
          return theme;
        }

        function cssColor(channels) {
          if (channels.length === 4) return 'rgba(' + channels.join(', ') + ')';
          return 'rgb(' + channels.join(', ') + ')';
        }

        function setThemeVariable(name, channels) {
          document.documentElement.style.setProperty(name, cssColor(channels));
        }

        function applyThemeScale(scale, persist) {
          const clamped = clampThemeScale(scale);
          const theme = themeAtScale(clamped);
          const mapping = {
            '--app-bg': theme.bg,
            '--surface': theme.surface,
            '--surface-soft': theme.surfaceSoft,
            '--surface-raised': theme.surfaceRaised,
            '--text': theme.text,
            '--muted': theme.muted,
            '--border': theme.border,
            '--border-strong': theme.borderStrong,
            '--primary': theme.primary,
            '--primary-hover': theme.primaryHover,
            '--primary-text': theme.primaryText,
            '--primary-soft': theme.primarySoft,
            '--secondary-bg': theme.secondaryBg,
            '--secondary-hover': theme.secondaryHover,
            '--success-bg': theme.successBg,
            '--success-text': theme.successText,
            '--warning-bg': theme.warningBg,
            '--warning-text': theme.warningText,
            '--danger-text': theme.dangerText,
            '--log-bg': theme.logBg,
            '--log-text': theme.logText,
            '--shadow': theme.shadow,
            '--focus-ring': theme.focusRing
          };

          for (const [name, channels] of Object.entries(mapping)) {
            setThemeVariable(name, channels);
          }

          document.documentElement.style.colorScheme = clamped >= 67 ? 'dark' : 'light';
          document.documentElement.dataset.themeScale = String(clamped);

          const input = document.getElementById('colorSchemeScale');
          const value = document.getElementById('colorSchemeValue');
          if (input) input.value = String(clamped);
          if (value) value.innerText = theme.name + ' - ' + clamped + '%';

          if (persist) {
            localStorage.setItem(THEME_STORAGE_KEY, String(clamped));
          }
        }

        function setThemeScale(value) {
          applyThemeScale(value, true);
        }

        function initializeThemeScale() {
          const stored = localStorage.getItem(THEME_STORAGE_KEY) || localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
          applyThemeScale(stored === null ? 0 : stored, false);
        }

        initializeThemeScale();
      
  </script>
</head>
<body>
  <div class="layout-container">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>Local Router</h2>
        <div class="muted" id="ollamaVersionBadge">Ollama API v0.6.4+</div>
      </div>
      <nav class="sidebar-nav">
        <a href="/config/providers" class="nav-link">Providers &amp; Models</a>
        <a href="/config/fallback" class="nav-link">Fallback Routes</a>
        <a href="/config/thinking" class="nav-link">Prompt &amp; Thinking</a>
        <a href="/config/pricing" class="nav-link">Pricing Overrides</a>
        <a href="/config/diagnostics" class="nav-link">Diagnostics &amp; Sessions</a>
      </nav>
      <div class="sidebar-footer">
        <div class="theme-panel-compact">
          <label for="themeSelect">Theme</label>
          <select id="themeSelect" onchange="setTheme(this.value)">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
      </div>
    </aside>
    <main class="main-content">
      <div id="message" style="margin-top:0; margin-bottom:20px; display:none; padding:10px 14px; border-radius:4px; font-weight:bold;"></div>
      ${bodyHtml}
    </main>
    <script>
    // Server-side parameters
    const params = {
      defaultFallbackModelsText: ${defaultFallbackModelsTextJs}
    };





      </script>
      <script>
        let providerConfigs = [];
        let fallbackRoutes = [];
        let diagnosticsEnabled = false;
        let activeModelEditId = '';
        let activeFallbackRouteId = '';
        const DEFAULT_FALLBACK_MODELS_TEXT = ${JSON.stringify(params.defaultFallbackModelsText)};
        let fallbackCandidateStore = [];
        let allModelsCache = [];
        let catalogInfoById = {};
        let modelAvailabilityCache = {};
        const ADD_CUSTOM_PROVIDER_VALUE = '__add_custom__';

        function escapeHtml(value) {
          return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }
        function setMessage(text, type) {
          const messageEl = document.getElementById('message');
          if (!messageEl) return;
          messageEl.classList.remove('error', 'success');
          messageEl.classList.add(type === 'error' ? 'error' : 'success');
          messageEl.innerText = text;
          messageEl.style.display = 'block';
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function suggestCustomKeyEnvFromSlug(slug) {
          const normalized = String(slug || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
          return (normalized || 'CUSTOM') + '_API_KEY';
        }

        function toggleCustomProviderPanel(show, mode, provider) {
          const panel = document.getElementById('customProviderPanel');
          const keySection = document.getElementById('providerKeySection');
          const titleEl = document.getElementById('customProviderPanelTitle');
          const slugEl = document.getElementById('customProviderSlug');
          const editModeEl = document.getElementById('customProviderEditMode');
          if (!panel || !keySection) return;

          if (show) {
            panel.style.display = 'block';
            keySection.classList.add('hidden');
            const isEdit = mode === 'edit' && provider;
            if (titleEl) titleEl.innerText = isEdit ? 'Edit custom provider' : 'Add custom provider';
            if (editModeEl) editModeEl.value = isEdit ? provider.name : '';
            if (slugEl) {
              slugEl.value = isEdit ? provider.name : '';
              slugEl.disabled = Boolean(isEdit);
            }
            const displayEl = document.getElementById('customProviderDisplayName');
            const keyEnvEl = document.getElementById('customProviderKeyEnv');
            const endpointEl = document.getElementById('customProviderEndpoint');
            const toolEl = document.getElementById('customProviderDefaultTool');
            if (isEdit) {
              if (displayEl) displayEl.value = provider.displayName || provider.name;
              if (keyEnvEl) keyEnvEl.value = provider.keyEnvVar || '';
              if (endpointEl) endpointEl.value = provider.endpoint || '';
              if (toolEl) toolEl.value = provider.defaultTool || 'OpenAI Compatible';
            } else {
              if (displayEl) displayEl.value = '';
              if (keyEnvEl) keyEnvEl.value = '';
              if (endpointEl) endpointEl.value = '';
              if (toolEl) toolEl.value = 'OpenAI Compatible';
            }
            return;
          }

          panel.style.display = 'none';
          keySection.classList.remove('hidden');
          if (slugEl) slugEl.disabled = false;
          if (editModeEl) editModeEl.value = '';
        }

        function cancelCustomProviderPanel() {
          const selectEl = document.getElementById('providerSelect');
          toggleCustomProviderPanel(false);
          if (selectEl && providerConfigs.length > 0) {
            selectEl.value = providerConfigs[0].name;
            selectEl.dispatchEvent(new Event('change'));
          }
        }

        async function saveCustomProvider() {
          const editName = (document.getElementById('customProviderEditMode') || {}).value || '';
          const slug = (document.getElementById('customProviderSlug') || {}).value.trim().toLowerCase();
          const displayName = (document.getElementById('customProviderDisplayName') || {}).value.trim();
          const keyEnvVar = (document.getElementById('customProviderKeyEnv') || {}).value.trim();
          const endpoint = (document.getElementById('customProviderEndpoint') || {}).value.trim();
          const defaultTool = (document.getElementById('customProviderDefaultTool') || {}).value.trim() || 'OpenAI Compatible';

          if (!slug || !endpoint) {
            setMessage('Provider id and upstream base URL are required.', 'error');
            return;
          }

          const payload = {
            name: slug,
            displayName: displayName || slug,
            keyEnvVar: keyEnvVar || suggestCustomKeyEnvFromSlug(slug),
            endpoint,
            defaultTool
          };

          const path = editName ? '/api/providers/' + encodeURIComponent(editName) : '/api/providers';
          const method = editName ? 'PUT' : 'POST';
          const res = await fetch(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(body?.error || 'Failed to save custom provider.', 'error');
            return;
          }

          setMessage(editName ? 'Custom provider updated.' : 'Custom provider created.', 'success');
          toggleCustomProviderPanel(false);
          await loadProviderConfigs();
          selectProvider(slug);
        }

        async function deleteCustomProvider(providerName) {
          if (!providerName) return;
          if (!window.confirm('Delete custom provider "' + providerName + '"? Models and optional key will be removed.')) {
            return;
          }

          const res = await fetch('/api/providers/' + encodeURIComponent(providerName) + '?unsetKey=true', {
            method: 'DELETE'
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(body?.error || 'Failed to delete custom provider.', 'error');
            return;
          }

          setMessage('Removed custom provider: ' + providerName, 'success');
          await loadProviderConfigs();
          await loadCatalog();
        }

        function openCustomProviderEditor(providerName) {
          const provider = providerConfigs.find((entry) => entry.name === providerName);
          if (!provider || !provider.isCustom) return;
          const selectEl = document.getElementById('providerSelect');
          if (selectEl) selectEl.value = ADD_CUSTOM_PROVIDER_VALUE;
          toggleCustomProviderPanel(true, 'edit', provider);
        }

        function renderProviderSelection() {
          const selectEl = document.getElementById('providerSelect');
          const envVarEl = document.getElementById('providerEnvVar');
          const providerCountEl = document.getElementById('providerCount');
          const existingSelection = selectEl.value;

          if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
            selectEl.innerHTML = '<option value="' + ADD_CUSTOM_PROVIDER_VALUE + '">Add custom provider…</option>';
            envVarEl.value = '';
            if (providerCountEl) providerCountEl.innerText = '0/0 configured';
            renderProviderModelList(null);
            toggleCustomProviderPanel(true, 'create', null);
            return;
          }

          const optionHtml = providerConfigs.map((provider) => {
            const label = provider.isCustom && provider.displayName
              ? provider.displayName + ' (' + provider.name + ')'
              : provider.name;
            return '<option value="' + escapeHtml(provider.name) + '">' + escapeHtml(label) + '</option>';
          }).join('') + '<option value="' + ADD_CUSTOM_PROVIDER_VALUE + '">Add custom provider…</option>';

          selectEl.innerHTML = optionHtml;
          if (existingSelection === ADD_CUSTOM_PROVIDER_VALUE) {
            selectEl.value = ADD_CUSTOM_PROVIDER_VALUE;
          } else if (providerConfigs.some((provider) => provider.name === existingSelection)) {
            selectEl.value = existingSelection;
          }

          const setSelectedProvider = () => {
            if (selectEl.value === ADD_CUSTOM_PROVIDER_VALUE) {
              envVarEl.value = '';
              toggleCustomProviderPanel(true, 'create', null);
              renderProviderModelList(null);
              highlightSelectedProvider('');
              return;
            }

            toggleCustomProviderPanel(false);
            const selected = providerConfigs.find((provider) => provider.name === selectEl.value) || providerConfigs[0];
            if (!selected) return;
            envVarEl.value = selected.keyEnvVar;
            clearProviderModelForm();
            renderProviderModelList(selected);
            highlightSelectedProvider(selected.name);
          };

          selectEl.onchange = setSelectedProvider;
          setSelectedProvider();

          const configuredCount = providerConfigs.filter((provider) => provider.configured).length;
          if (providerCountEl) providerCountEl.innerText = configuredCount + '/' + providerConfigs.length + ' configured';

          // The per-provider key cards live inline in the catalog group
          // headers now (one section per provider — no grid/catalog double
          // scroll). Refresh group headers if the catalog already rendered.
          if (Array.isArray(curationCatalogData) && curationCatalogData.length > 0) {
            renderCurationCatalog();
          }
        }

        function selectProvider(providerName) {
          const selectEl = document.getElementById('providerSelect');
          selectEl.value = providerName;
          selectEl.dispatchEvent(new Event('change'));
          highlightSelectedProvider(providerName);
        }

        function highlightSelectedProvider(providerName) {
          document.querySelectorAll('.provider-group').forEach((group) => {
            group.classList.toggle('active', group.getAttribute('data-provider') === providerName);
          });
        }

        function selectedProviderConfig() {
          const providerName = document.getElementById('providerSelect').value;
          return providerConfigs.find((provider) => provider.name === providerName) || null;
        }

        function clearProviderModelForm() {
          activeModelEditId = '';
          document.getElementById('modelUpstream').value = '';
          document.getElementById('modelPresented').value = '';
          document.getElementById('modelContextLength').value = '64000';
          document.getElementById('modelOutputTokens').value = '4096';
          document.getElementById('modelSupportsTools').checked = true;
          document.getElementById('modelSupportsImages').checked = false;
          document.getElementById('modelSupportsCache').checked = false;
          document.getElementById('modelSupportsReasoning').checked = false;
        }

        function renderProviderModelList(provider) {
          const listEl = document.getElementById('providerModelList');
          const models = Array.isArray(provider?.models) ? provider.models : [];
          if (!provider) {
            listEl.innerHTML = '<div class="provider-model-empty">Select a provider to manage models.</div>';
            return;
          }
          if (models.length === 0) {
            listEl.innerHTML = '<div class="provider-model-empty">No models configured for this provider.</div>';
            return;
          }

          listEl.innerHTML = models.map((model) => {
            const tags = [];
            if (provider.name === 'cline' || provider.name === 'kilo') {
              if (model.id.endsWith('-free')) tags.push('free');
              else if (model.id.endsWith('-paid')) tags.push('paid');
            }
            if (model.supportsTools) tags.push('tools');
            if (model.supportsImages) tags.push('vision');
            if (model.supportsCache) tags.push('cache');
            if (model.supportsReasoning) tags.push('reasoning');
            const renderedTags = tags.length > 0
              ? tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('')
              : '<span class="tag">completion</span>';
            const friendlyLabel = model.display && model.display !== model.id
              ? '<div class="meta">Label: ' + escapeHtml(model.display) + '</div>'
              : '';

            return '<div class="provider-model-item" data-model-id="' + escapeHtml(model.id) + '">' +
              '<h5>' + escapeHtml(model.id) + '</h5>' +
              friendlyLabel +
              '<div class="meta">Upstream: ' + escapeHtml(model.model) + '</div>' +
              '<div class="meta">Context: ' + escapeHtml(model.contextLength) + ' | Output: ' + escapeHtml(model.outputTokens) + '</div>' +
              '<div class="meta">Source: ' + escapeHtml(provider.modelSource || provider.source || 'baseline') + '</div>' +
              '<div class="tags">' + renderedTags + '</div>' +
              '<div class="actions">' +
                '<button class="button-secondary" data-edit-model="' + escapeHtml(model.id) + '">Edit</button>' +
                '<button class="button-secondary" data-delete-model="' + escapeHtml(model.id) + '">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');

          listEl.querySelectorAll('button[data-edit-model]').forEach((button) => {
            button.addEventListener('click', () => {
              const modelId = button.getAttribute('data-edit-model') || '';
              const selectedModel = models.find((entry) => entry.id === modelId);
              if (!selectedModel) return;
              activeModelEditId = selectedModel.id;
              document.getElementById('modelUpstream').value = selectedModel.model || '';
              document.getElementById('modelPresented').value = selectedModel.id || '';
              document.getElementById('modelContextLength').value = String(selectedModel.contextLength || 64000);
              document.getElementById('modelOutputTokens').value = String(selectedModel.outputTokens || 4096);
              document.getElementById('modelSupportsTools').checked = Boolean(selectedModel.supportsTools);
              document.getElementById('modelSupportsImages').checked = Boolean(selectedModel.supportsImages);
              document.getElementById('modelSupportsCache').checked = Boolean(selectedModel.supportsCache);
              document.getElementById('modelSupportsReasoning').checked = Boolean(selectedModel.supportsReasoning);
            });
          });

          listEl.querySelectorAll('button[data-delete-model]').forEach((button) => {
            button.addEventListener('click', () => {
              deleteProviderModel(button.getAttribute('data-delete-model') || '');
            });
          });
        }

        async function saveProviderModel() {
          const provider = document.getElementById('providerSelect').value;
          const model = document.getElementById('modelUpstream').value.trim();
          const presentedName = document.getElementById('modelPresented').value.trim();
          const contextLengthRaw = Number.parseInt(document.getElementById('modelContextLength').value, 10);
          const outputTokensRaw = Number.parseInt(document.getElementById('modelOutputTokens').value, 10);

          if (!provider || !model) {
            setMessage('Select a provider and enter an upstream model ID.', 'error');
            return;
          }
          if (!Number.isInteger(contextLengthRaw) || contextLengthRaw <= 0) {
            setMessage('Context length must be a positive integer.', 'error');
            return;
          }
          if (!Number.isInteger(outputTokensRaw) || outputTokensRaw <= 0) {
            setMessage('Max output tokens must be a positive integer.', 'error');
            return;
          }

          const payload = {
            model,
            id: presentedName || undefined,
            contextLength: contextLengthRaw,
            outputTokens: outputTokensRaw,
            supportsTools: document.getElementById('modelSupportsTools').checked,
            supportsImages: document.getElementById('modelSupportsImages').checked,
            supportsCache: document.getElementById('modelSupportsCache').checked,
            supportsReasoning: document.getElementById('modelSupportsReasoning').checked
          };

          const res = await fetch('/api/provider-models/' + encodeURIComponent(provider) + '/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const responsePayload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(responsePayload?.error || 'Failed to save provider model.', 'error');
            return;
          }

          const action = activeModelEditId ? 'updated' : 'added';
          setMessage('Provider model ' + action + ' in-memory successfully.', 'success');
          clearProviderModelForm();
          await loadProviderConfigs();
          await loadCatalog();
        }

        async function deleteProviderModel(modelId) {
          const provider = document.getElementById('providerSelect').value;
          if (!provider || !modelId) return;

          const res = await fetch('/api/provider-models/' + encodeURIComponent(provider) + '/models/' + encodeURIComponent(modelId), {
            method: 'DELETE'
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to delete provider model.', 'error');
            return;
          }

          setMessage('Removed provider model: ' + modelId, 'success');
          if (activeModelEditId === modelId) {
            clearProviderModelForm();
          }
          await loadProviderConfigs();
          await loadCatalog();
        }

        var NEW_FALLBACK_CHAIN_VALUE = '__new__';

        function currentFallbackEditTarget() {
          var sel = document.getElementById('fallbackRouteSelect');
          var raw = sel && sel.value ? sel.value : '';
          if (raw && raw !== NEW_FALLBACK_CHAIN_VALUE) return { mode: 'existing', id: raw };
          var nameEl = document.getElementById('fallbackRouteNewName');
          var name = nameEl ? nameEl.value.trim() : '';
          return { mode: 'new', id: name };
        }

        function hydrateFallbackForm(route) {
          var disabled = new Set(route && Array.isArray(route.disabledModels) ? route.disabledModels : []);
          fallbackCandidateStore = (route && Array.isArray(route.models) ? route.models : []).map(function(modelId) {
            return { model: modelId, enabled: !disabled.has(modelId) };
          });
          renderFallbackCandidateList();
          syncFallbackCandidatesToTextarea();
        }

        function selectFallbackRouteToEdit(value) {
          var nameEl = document.getElementById('fallbackRouteNewName');
          if (value === NEW_FALLBACK_CHAIN_VALUE) {
            activeFallbackRouteId = '';
            if (nameEl) {
              nameEl.style.display = '';
              nameEl.value = '';
            }
            fallbackCandidateStore = [];
            renderFallbackCandidateList();
            syncFallbackCandidatesToTextarea();
            return;
          }
          if (nameEl) nameEl.style.display = 'none';
          if (!value) return;
          activeFallbackRouteId = value;
          var route = (Array.isArray(fallbackRoutes) ? fallbackRoutes : []).find(function(entry) { return entry.id === value; });
          if (route) hydrateFallbackForm(route);
        }

        function populateFallbackRouteSelect() {
          var sel = document.getElementById('fallbackRouteSelect');
          if (!sel) return;
          var routes = Array.isArray(fallbackRoutes) ? fallbackRoutes : [];
          var preferred = ['local-router/fallback-models', 'local-router/free', 'local-router/performance', 'local-router/multimodal'];
          var orderedIds = preferred.filter(function(id) {
            return routes.some(function(r) { return r.id === id; });
          });
          routes.forEach(function(r) {
            if (orderedIds.indexOf(r.id) === -1) orderedIds.push(r.id);
          });
          sel.innerHTML = orderedIds.map(function(id) {
            return '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>';
          }).join('') + '<option value="' + NEW_FALLBACK_CHAIN_VALUE + '">— New chain…</option>';
          var wanted = (activeFallbackRouteId && orderedIds.indexOf(activeFallbackRouteId) !== -1)
            ? activeFallbackRouteId
            : (orderedIds[0] || NEW_FALLBACK_CHAIN_VALUE);
          sel.value = wanted;
          selectFallbackRouteToEdit(wanted);
        }

        function clearFallbackRouteForm() {
          var sel = document.getElementById('fallbackRouteSelect');
          if (sel) sel.value = NEW_FALLBACK_CHAIN_VALUE;
          selectFallbackRouteToEdit(NEW_FALLBACK_CHAIN_VALUE);
        }

        async function applyFallbackDefaults() {
          var sel = document.getElementById('fallbackRouteSelect');
          if (sel && fallbackRoutes.some(function(r) { return r.id === 'local-router/fallback-models'; })) {
            activeFallbackRouteId = 'local-router/fallback-models';
            sel.value = 'local-router/fallback-models';
            selectFallbackRouteToEdit('local-router/fallback-models');
          }
          document.getElementById('fallbackModelsText').value = DEFAULT_FALLBACK_MODELS_TEXT;
          applyFallbackTextareaToStore();
          await saveFallbackRoute();
        }

        function availabilityBadgeHtml(modelId) {
          var entry = modelAvailabilityCache[modelId];
          if (!entry) return '';
          var label = entry.status === 'ready' ? 'Ready' : entry.status === 'no_key' ? 'No key' : 'Unavailable';
          return '<span class="candidate-status ' + escapeHtml(entry.status) + '">' + escapeHtml(label) + '</span>';
        }

        async function refreshModelAvailability(modelIds) {
          var ids = Array.from(new Set((modelIds || []).filter(Boolean)));
          if (!ids.length) return;
          try {
            var res = await fetch('/api/routing/availability?models=' + encodeURIComponent(ids.join(',')));
            var payload = await res.json().catch(function() { return {}; });
            var rows = Array.isArray(payload?.data) ? payload.data : [];
            rows.forEach(function(entry) {
              if (entry && entry.model) modelAvailabilityCache[entry.model] = entry;
            });
          } catch {
            // Best-effort UI enrichment only.
          }
        }

        function renderFallbackRoutes() {
          const countEl = document.getElementById('fallbackCount');
          const listEl = document.getElementById('fallbackRouteList');
          if (!countEl || !listEl) return; // only the Fallback Routes page hosts the editor
          const routes = Array.isArray(fallbackRoutes) ? fallbackRoutes : [];
          countEl.innerText = routes.length + ' fallback route' + (routes.length === 1 ? '' : 's');

          if (routes.length === 0) {
            listEl.innerHTML = '<div class="fallback-route-empty">No fallback routes configured yet.</div>';
            return;
          }

          listEl.innerHTML = routes.map((route) => {
            const models = Array.isArray(route.models) ? route.models : [];
            const disabled = new Set(Array.isArray(route.disabledModels) ? route.disabledModels : []);
            const detailByModel = {};
            (Array.isArray(route.chainDetails) ? route.chainDetails : []).forEach(function(detail) {
              if (detail && detail.id) detailByModel[detail.id] = detail;
            });
            const chainHtml = models.map((modelId) => {
              const isEnabled = !disabled.has(modelId);
              var badge = availabilityBadgeHtml(modelId);
              if (!isEnabled) {
                badge = '<span class="candidate-status disabled" style="background:#ea4335;color:white;opacity:0.6;">Disabled</span>';
              }
              var style = !isEnabled ? ' style="text-decoration: line-through; opacity: 0.6;"' : '';
              var detail = detailByModel[modelId];
              var tip = modelId;
              if (detail) {
                var tipParts = [];
                if (detail.provider) tipParts.push('provider: ' + detail.provider);
                if (typeof detail.contextLength === 'number') tipParts.push('context: ' + detail.contextLength);
                if (typeof detail.outputTokens === 'number') tipParts.push('max output: ' + detail.outputTokens);
                if (detail.supportsTools !== null && detail.supportsTools !== undefined) tipParts.push('tools: ' + (detail.supportsTools ? 'yes' : 'no'));
                if (detail.supportsVision !== null && detail.supportsVision !== undefined) tipParts.push('vision: ' + (detail.supportsVision ? 'yes' : 'no'));
                if (detail.status) tipParts.push('status: ' + detail.status);
                if (detail.known === false) tipParts.push('not in catalog');
                if (tipParts.length) tip = modelId + ' — ' + tipParts.join(' · ');
              }
              var spec = modelConfigSummaryHtml(modelId);
              return '<span' + style + ' title="' + escapeHtml(tip) + '">' + escapeHtml(modelId) + '</span>' + badge + spec;
            }).join(' → ');
            const readyCount = models.filter(function(modelId) { return detailByModel[modelId] && detailByModel[modelId].status === 'ready'; }).length;
            const readinessMeta = '<div class="meta">' + readyCount + ' of ' + models.length + ' chain models ready (provider key configured)</div>';
            return '<div class="fallback-route-item" data-fallback-route="' + escapeHtml(route.id) + '">' +
              '<h4>' + escapeHtml(route.id) + '</h4>' +
              '<div class="meta">Chain: ' + chainHtml + '</div>' +
              readinessMeta +
              '<div class="meta">Displayed as: ' + escapeHtml(route.display || ('fallback:' + models.join(' -> '))) + '</div>' +
              '<div class="actions">' +
                '<button class="button-secondary" data-delete-fallback="' + escapeHtml(route.id) + '">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');

          listEl.querySelectorAll('button[data-delete-fallback]').forEach((button) => {
            button.addEventListener('click', () => {
              deleteFallbackRoute(button.getAttribute('data-delete-fallback') || '');
            });
          });
        }

        async function loadFallbackRoutes() {
          const res = await fetch('/api/fallback-models');
          const payload = await res.json().catch(() => ({}));
          fallbackRoutes = Array.isArray(payload?.data) ? payload.data : [];
          mergeChainDetailsIntoInfo(fallbackRoutes);
          const modelIds = fallbackRoutes.flatMap((route) => Array.isArray(route.models) ? route.models : []);
          await refreshModelAvailability(modelIds);
          renderFallbackRoutes();
          if (!activeFallbackRouteId && fallbackRoutes.some((r) => r.id === 'local-router/fallback-models')) {
            activeFallbackRouteId = 'local-router/fallback-models';
          }
          populateFallbackRouteSelect();
        }

        async function saveFallbackRoute() {
          const target = currentFallbackEditTarget();
          const id = target.id;
          syncFallbackCandidatesToTextarea();
          const modelsText = document.getElementById('fallbackModelsText').value.trim();

          if (!id || !modelsText) {
            setMessage(target.mode === 'new'
              ? 'Enter a name for the new chain and at least two model entries.'
              : 'Add at least two model entries to the selected chain.', 'error');
            return;
          }

          const res = await fetch('/api/fallback-models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, modelsText })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to save fallback route.', 'error');
            return;
          }

          setMessage('Fallback route saved persistently.', 'success');
          activeFallbackRouteId = (payload && payload.model && payload.model.id) || ('local-router/' + (id.indexOf('local-router/') === 0 ? id.substring('local-router/'.length) : id));
          await loadFallbackRoutes();
          await loadCatalog();
        }

        async function autoSaveFallbackRoute() {
          syncFallbackCandidatesToTextarea();
          const target = currentFallbackEditTarget();
          const id = target.mode === 'existing' ? target.id : '';
          const modelsText = document.getElementById('fallbackModelsText').value.trim();
          if (!id || !modelsText) return;
          try {
            const res = await fetch('/api/fallback-models', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, modelsText })
            });
            if (res.ok) await loadFallbackRoutes();
          } catch {
            // Silent auto-save — best effort.
          }
        }

        async function deleteFallbackRoute(routeId) {
          if (!routeId) return;

          const res = await fetch('/api/fallback-models', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: routeId })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to delete fallback route.', 'error');
            return;
          }

          setMessage('Removed fallback route: ' + routeId, 'success');
          if (activeFallbackRouteId === routeId) {
            clearFallbackRouteForm();
          }
          await loadFallbackRoutes();
          await loadCatalog();
        }

        async function exportFallbackSettings() {
          const res = await fetch('/api/router-settings');
          const settings = await res.json().catch(() => ({}));
          const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'router-settings.json';
          a.click();
          URL.revokeObjectURL(url);
        }

        async function importFallbackSettings(event) {
          const file = event.target.files && event.target.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            const settings = JSON.parse(text);
            await fetch('/api/router-settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings)
            });
            setMessage('Router settings imported.', 'success');
            await loadFallbackRoutes();
          } catch (e) {
            setMessage('Failed to import router settings.', 'error');
          }
          event.target.value = '';
        }

        async function resetFallbackSettings() {
          if (!window.confirm('Reset router settings to defaults?')) return;
          await fetch('/api/router-settings', { method: 'DELETE' });
          setMessage('Router settings reset to defaults.', 'success');
          await loadFallbackRoutes();
        }

        // ── Visual Builder Dropdown ──
        // Source: the full toggle catalog (/api/model-curation) — the same
        // inventory /api/fallback-chain/toggle and save validation accept —
        // NOT the curated /api/tags serving subset. Otherwise models the
        // operator flagged for the fallback chain (but did not also check for
        // direct serving) silently vanish from "Add Model to Chain".
        async function buildModelDropdown() {
          try {
            const res = await fetch('/api/model-curation');
            const payload = await res.json();
            const groups = Array.isArray(payload?.data) ? payload.data : [];
            const ids = [];
            const infoMap = {};
            for (const group of groups) {
              for (const model of (group && Array.isArray(group.models) ? group.models : [])) {
                if (!model || !model.id) continue;
                ids.push(model.id);
                infoMap[model.id] = {
                  provider: group.provider || model.provider || '',
                  contextLength: typeof model.contextLength === 'number' ? model.contextLength : null,
                  outputTokens: typeof model.outputTokens === 'number' ? model.outputTokens : null,
                  supportsTools: typeof model.supportsTools === 'boolean' ? model.supportsTools : null,
                  supportsVision: typeof model.supportsImages === 'boolean' ? model.supportsImages : null
                };
              }
            }
            if (ids.length === 0) throw new Error('empty catalog');
            catalogInfoById = infoMap;
            allModelsCache = ids.sort();
          } catch (e) {
            // Legacy/edge fallback: the served-tags subset.
            try {
              const tagsRes = await fetch('/api/tags');
              const data = await tagsRes.json();
              allModelsCache = (data.models || []).map(function(m) { return m.name; }).sort();
            } catch (e2) {
              allModelsCache = [];
            }
          }
        }

        // Merge per-member configs reported by /api/fallback-models
        // (chainDetails) into the shared info map so chain views render specs
        // even before (or without) a catalog refresh.
        function mergeChainDetailsIntoInfo(routes) {
          (Array.isArray(routes) ? routes : []).forEach(function(route) {
            (Array.isArray(route?.chainDetails) ? route.chainDetails : []).forEach(function(detail) {
              if (!detail || !detail.id) return;
              const existing = catalogInfoById[detail.id] || {};
              catalogInfoById[detail.id] = {
                provider: existing.provider || detail.provider || '',
                contextLength: existing.contextLength ?? detail.contextLength ?? null,
                outputTokens: existing.outputTokens ?? detail.outputTokens ?? null,
                supportsTools: existing.supportsTools ?? detail.supportsTools ?? null,
                supportsVision: existing.supportsVision ?? detail.supportsVision ?? null,
                status: detail.status || existing.status || null
              };
            });
          });
        }

        function modelConfigSummaryHtml(modelId) {
          const info = catalogInfoById[modelId];
          if (!info) return '';
          const parts = [];
          if (typeof info.contextLength === 'number' && info.contextLength > 0) {
            parts.push(Math.round(info.contextLength / 1000) + 'k ctx');
          }
          if (typeof info.outputTokens === 'number' && info.outputTokens > 0) {
            parts.push(Math.round(info.outputTokens / 1000) + 'k out');
          }
          if (info.supportsTools === true) parts.push('tools');
          if (info.supportsVision === true) parts.push('vision');
          if (parts.length === 0) return '';
          return '<span class="model-config-summary muted" title="' + escapeHtml(parts.join(' · ')) + '">' + escapeHtml(parts.join(' · ')) + '</span>';
        }

        async function hydrateOllamaVersionBadge() {
          const el = document.getElementById('ollamaVersionBadge');
          if (!el) return;
          try {
            const res = await fetch('/api/version');
            const payload = await res.json().catch(() => ({}));
            if (payload && typeof payload.version === 'string' && payload.version) {
              el.textContent = 'Ollama API v' + payload.version + ' · mirrored from backend';
              el.title = 'Reported by /api/version — mirror of the real ollama on this host (env OLLAMA_VERSION overrides; floor 0.6.4).';
            }
          } catch (e) {
            // Static badge stays as-is when the probe fails.
          }
        }

        // ── Drag and Drop (Fallback Routes page candidate list) ──
        var dragSourceIndex = -1;

        function candidateDragStart(e) {
          var itemEl = e.target.closest('[data-candidate-index]');
          if (!itemEl) return;
          dragSourceIndex = parseInt(itemEl.getAttribute('data-candidate-index'), 10);
          itemEl.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        }

        function candidateDragOver(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }

        function candidateDrop(e) {
          e.preventDefault();
          var targetEl = e.target.closest('[data-candidate-index]');
          if (!targetEl || dragSourceIndex < 0) return;
          var targetIndex = parseInt(targetEl.getAttribute('data-candidate-index'), 10);
          if (targetIndex === dragSourceIndex) return;
          var moved = fallbackCandidateStore.splice(dragSourceIndex, 1)[0];
          fallbackCandidateStore.splice(targetIndex, 0, moved);
          renderFallbackCandidateList();
          syncFallbackCandidatesToTextarea();
          autoSaveFallbackRoute();
          dragSourceIndex = -1;
        }

        function candidateDragEnd(e) {
          var items = document.querySelectorAll('.router-candidate-item.dragging');
          items.forEach(function(el) { el.classList.remove('dragging'); });
          dragSourceIndex = -1;
        }

        function parseFallbackTextareaToStore(text) {
          if (!text) return [];
          return text.split(/\\r?\\n|;/).map(function(line) {
            var trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return null;
            var directiveMatch = trimmed.match(/^(.*?)\s+(!enabled|disabled)$/i);
            var modelName;
            var enabled = true;
            if (directiveMatch) {
              modelName = directiveMatch[1].trim();
              enabled = false;
            } else {
              modelName = trimmed;
            }
            return { model: modelName, enabled: enabled };
          }).filter(function(entry) { return entry && entry.model; });
        }

        function applyFallbackTextareaToStore() {
          var text = document.getElementById('fallbackModelsText').value;
          fallbackCandidateStore = parseFallbackTextareaToStore(text);
          renderFallbackCandidateList();
        }

        function addFallbackCandidate(model) {
          var trimmed = String(model || '').trim();
          if (!trimmed) return;
          if (fallbackCandidateStore.some(function(c) { return c.model === trimmed; })) return;
          fallbackCandidateStore.push({ model: trimmed, enabled: true });
          renderFallbackCandidateList();
          syncFallbackCandidatesToTextarea();
        }

        function removeFallbackCandidate(index) {
          if (index < 0 || index >= fallbackCandidateStore.length) return;
          fallbackCandidateStore.splice(index, 1);
          renderFallbackCandidateList();
          syncFallbackCandidatesToTextarea();
        }

        function toggleFallbackCandidate(index, enabled) {
          if (index < 0 || index >= fallbackCandidateStore.length) return;
          fallbackCandidateStore[index].enabled = Boolean(enabled);
          renderFallbackCandidateList();
          syncFallbackCandidatesToTextarea();
        }

        function renderFallbackCandidateList() {
          var listEl = document.getElementById('fallbackCandidateList');
          if (!listEl) return;
          if (fallbackCandidateStore.length === 0) {
            listEl.innerHTML = '<div class="router-candidate-empty">No candidates added yet. Search and add models above.</div>';
            return;
          }
          listEl.innerHTML = fallbackCandidateStore.map(function(c, i) {
            var modelParts = c.model.split('-');
            var provider = modelParts.length > 1 ? modelParts.slice(0, modelParts.length > 2 ? modelParts.length - 2 : 1).join('-') : '';
            var badge = provider ? '<span class="provider-badge">' + escapeHtml(provider) + '</span>' : '';
            var statusBadge = availabilityBadgeHtml(c.model);
            var specBadge = modelConfigSummaryHtml(c.model);
            var isEnabled = c.enabled !== false;
            var disabledClass = !isEnabled ? ' router-candidate-disabled' : '';
            return '<div class="router-candidate-item' + disabledClass + '" draggable="true" data-candidate-index="' + i + '" ondragstart="candidateDragStart(event)" ondragover="candidateDragOver(event)" ondrop="candidateDrop(event)" ondragend="candidateDragEnd(event)">' +
              '<span class="drag-handle" title="Drag to reorder">☰</span>' +
              '<input type="checkbox" class="candidate-toggle" ' + (isEnabled ? 'checked' : '') + ' onchange="toggleFallbackCandidate(' + i + ', this.checked)" title="' + (isEnabled ? 'Enabled — will be tried' : 'Disabled — skipped at execution') + '">' +
              '<div class="candidate-info">' +
                '<span class="candidate-model">' + escapeHtml(c.model) + '</span>' + badge + statusBadge + specBadge +
              '</div>' +
              '<button class="remove-btn" title="Remove" onclick="removeFallbackCandidate(' + i + ')">✕</button>' +
            '</div>';
          }).join('');
          liveUpdateFallbackRouteItem();
        }

        function syncFallbackCandidatesToTextarea() {
          var textarea = document.getElementById('fallbackModelsText');
          if (!textarea) return;
          textarea.value = fallbackCandidateStore.map(function(c) {
            return c.enabled === false ? (c.model + ' disabled') : c.model;
          }).join('\\n');
        }

        function filterFallbackModelDropdown() {
          var searchEl = document.getElementById('fallbackModelSearch');
          var dd = document.getElementById('fallbackModelDropdown');
          if (!searchEl || !dd) return;
          var search = (searchEl.value || '').toLowerCase();
          var filtered = allModelsCache;
          if (search) {
            filtered = allModelsCache.filter(function(m) { return m.toLowerCase().indexOf(search) !== -1; });
          }
          if (filtered.length === 0) {
            dd.innerHTML = '<div class="dropdown-search-item muted">No models match "' + escapeHtml(search) + '"</div>';
          } else {
            dd.innerHTML = filtered.slice(0, 50).map(function(m) {
              var parts = m.split('-');
              var provider = parts.length > 1 ? parts.slice(0, parts.length > 2 ? parts.length - 2 : 1).join('-') : '';
              var badge = provider ? '<span class="provider-badge">' + escapeHtml(provider) + '</span>' : '';
              var inChain = fallbackCandidateStore.some(function(c) { return c.model === m; });
              var chainMark = inChain ? '<span class="in-chain-badge" title="Already in this chain">✓ in chain</span>' : '';
              var spec = modelConfigSummaryHtml(m);
              return '<div class="dropdown-search-item" data-model="' + escapeHtml(m) + '" onmousedown="addFallbackCandidateFromDropdown(&apos;' + escapeHtml(m).replace(/'/g, '&apos;') + '&apos;)">' +
                '<span>' + escapeHtml(m) + '</span>' + badge + spec + chainMark +
              '</div>';
            }).join('');
          }
          dd.style.display = 'block';
        }

        function openFallbackModelDropdown() {
          filterFallbackModelDropdown();
        }

        function closeFallbackModelDropdown() {
          var dd = document.getElementById('fallbackModelDropdown');
          if (dd) dd.style.display = 'none';
        }

        function addFallbackCandidateFromDropdown(model) {
          addFallbackCandidate(model);
          var searchEl = document.getElementById('fallbackModelSearch');
          if (searchEl) searchEl.value = '';
          closeFallbackModelDropdown();
        }

        // Close the chain-model dropdown on outside click / Escape (it stayed
        // open after selection and clicks elsewhere before the 2026-08-24 fix).
        document.addEventListener('mousedown', function(e) {
          var dd = document.getElementById('fallbackModelDropdown');
          if (!dd || dd.style.display === 'none') return;
          var container = dd.closest('.dropdown-search-container');
          if (container && !container.contains(e.target)) closeFallbackModelDropdown();
        });
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') closeFallbackModelDropdown();
        });

        function addSelectedFallbackCandidate() {
          var searchEl = document.getElementById('fallbackModelSearch');
          var model = (searchEl && searchEl.value || '').trim();
          if (!model) return;
          addFallbackCandidate(model);
          if (searchEl) {
            searchEl.value = '';
            searchEl.focus();
          }
          closeFallbackModelDropdown();
        }

        function liveUpdateFallbackRouteItem() {
          if (!activeFallbackRouteId) return;
          var routeItemEl = document.querySelector('.fallback-route-item[data-fallback-route="' + activeFallbackRouteId + '"]');
          if (!routeItemEl) return;
          var candidates = fallbackCandidateStore || [];
          var models = candidates.map(function(c) { return c.model; }).filter(Boolean);
          var chainHtml = candidates.map(function(c) {
            var modelId = c.model;
            var isEnabled = c.enabled !== false;
            var badge = availabilityBadgeHtml(modelId);
            if (!isEnabled) {
              badge = '<span class="candidate-status disabled" style="background:#ea4335;color:white;opacity:0.6;">Disabled</span>';
            }
            var style = !isEnabled ? ' style="text-decoration: line-through; opacity: 0.6;"' : '';
            return '<span' + style + '>' + escapeHtml(modelId) + '</span>' + badge;
          }).join(' → ');
          var metaDivs = routeItemEl.querySelectorAll('.meta');
          metaDivs.forEach(function(div) {
            if (div.textContent.startsWith('Chain:')) {
              div.innerHTML = 'Chain: ' + chainHtml;
            } else if (div.textContent.startsWith('Displayed as:')) {
              var displayString = activeFallbackRouteId + ': ' + models.join(' -> ');
              div.innerHTML = 'Displayed as: ' + escapeHtml(displayString);
            }
          });
        }
        function formatDiagnosticsEntry(entry) {
          const timestamp = entry?.timestamp || '';
          const event = entry?.event || 'event';
          const route = entry?.route || '';
          const provider = entry?.provider ? ' provider=' + entry.provider : '';
          const model = entry?.presentedModel ? ' model=' + entry.presentedModel : '';
          const actual = entry?.actualModel ? ' upstream=' + entry.actualModel : '';
          const stream = entry?.stream !== undefined ? ' stream=' + Boolean(entry.stream) : '';
          const status = entry?.status !== undefined ? ' status=' + entry.status : '';
          const duration = entry?.durationMs !== undefined ? ' durationMs=' + entry.durationMs : '';
          const summary = JSON.stringify(entry?.data || {}, null, 2);
          return '[' + timestamp + '] ' + event + ' route=' + route + provider + model + actual + stream + status + duration + '\\n' + summary;
        }

        async function refreshDiagnostics() {
          const statusEl = document.getElementById('diagnosticsStatus');
          const toggleEl = document.getElementById('diagnosticsToggle');
          const logEl = document.getElementById('diagnosticsLog');

          try {
            const res = await fetch('/api/diagnostics?limit=120');
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              statusEl.innerText = payload?.error || 'Diagnostics unavailable';
              logEl.textContent = 'Failed to load diagnostics.';
              return;
            }

            diagnosticsEnabled = Boolean(payload?.enabled);
            const entryCount = Number(payload?.entryCount || 0);
            const maxEntries = Number(payload?.maxEntries || 0);
            statusEl.innerText = (diagnosticsEnabled ? 'Enabled' : 'Disabled') + ' | ' + entryCount + '/' + maxEntries + ' entries';
            toggleEl.innerText = diagnosticsEnabled ? 'Disable Diagnostics' : 'Enable Diagnostics';

            const entries = Array.isArray(payload?.entries) ? payload.entries : [];
            const rendered = entries.map((entry) => formatDiagnosticsEntry(entry)).join('\\n\\n');
            logEl.textContent = rendered || 'No diagnostics captured yet.';
          } catch (error) {
            statusEl.innerText = 'Diagnostics unavailable';
            logEl.textContent = 'Failed to load diagnostics.';
          }
        }

        async function toggleDiagnostics() {
          const nextState = !diagnosticsEnabled;
          const res = await fetch('/api/diagnostics', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextState })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update diagnostics setting.', 'error');
            return;
          }

          diagnosticsEnabled = Boolean(payload?.enabled);
          setMessage('Diagnostics ' + (diagnosticsEnabled ? 'enabled' : 'disabled') + '.', 'success');
          await refreshDiagnostics();
        }

        async function clearDiagnostics() {
          const res = await fetch('/api/diagnostics', { method: 'DELETE' });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to clear diagnostics.', 'error');
            return;
          }

          setMessage('Diagnostics cleared.', 'success');
          await refreshDiagnostics();
        }
        let systemPromptDefault = '';
        let thinkingConfig = { global: 'none', default: 'none', providers: [] };
        async function loadSystemPrompt() {
          try {
            const res = await fetch('/api/system-prompt');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const toggleEl = document.getElementById('systemPromptToggle');
            const fieldsEl = document.getElementById('systemPromptFields');
            const textEl = document.getElementById('systemPromptText');
            const statusEl = document.getElementById('systemPromptStatus');
            systemPromptDefault = data.defaultPrompt || '';
            if (toggleEl) toggleEl.checked = Boolean(data.enabled);
            if (textEl) textEl.value = data.prompt || '';
            if (fieldsEl) fieldsEl.style.display = data.enabled ? 'block' : 'none';
            if (statusEl) statusEl.textContent = data.enabled ? 'Active — injecting into all requests' : 'Disabled';
          } catch (err) {
            console.error('loadSystemPrompt failed:', err);
            const statusEl = document.getElementById('systemPromptStatus');
            if (statusEl) statusEl.textContent = 'Failed to load';
          }
        }
        async function loadThinkingConfig() {
          try {
            const res = await fetch('/api/thinking-level');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            thinkingConfig = await res.json();
            const toggleEl = document.getElementById('thinkingProxyToggle');
            const fieldsEl = document.getElementById('thinkingConfigFields');
            const levelSelect = document.getElementById('thinkingLevelSelect');
            if (toggleEl) toggleEl.checked = Boolean(thinkingConfig.enabled);
            if (fieldsEl) fieldsEl.style.display = thinkingConfig.enabled ? 'block' : 'none';
            if (levelSelect) levelSelect.value = thinkingConfig.global || 'none';
            updateThinkingStatusText();
            renderProviderThinkingGrid();
          } catch (err) {
            console.error('loadThinkingConfig failed:', err);
            const thinkingStatusEl = document.getElementById('thinkingLevelStatus');
            if (thinkingStatusEl) thinkingStatusEl.textContent = 'Failed to load';
          }
        }
        function updateThinkingStatusText() {
          const thinkingStatusEl = document.getElementById('thinkingLevelStatus');
          if (!thinkingStatusEl) return;
          if (!thinkingConfig.enabled) {
            thinkingStatusEl.textContent = 'Passthrough — client controls thinking';
            return;
          }
          thinkingStatusEl.textContent = 'Proxy active — global: ' + (thinkingConfig.global || 'none');
        }
        async function toggleThinkingProxy() {
          const toggleEl = document.getElementById('thinkingProxyToggle');
          const fieldsEl = document.getElementById('thinkingConfigFields');
          const enabled = Boolean(toggleEl?.checked);
          if (fieldsEl) fieldsEl.style.display = enabled ? 'block' : 'none';
          const res = await fetch('/api/thinking-level', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update thinking proxy.', 'error');
            if (toggleEl) toggleEl.checked = !enabled;
            return;
          }
          thinkingConfig = payload;
          updateThinkingStatusText();
          setMessage('Thinking proxy ' + (payload.enabled ? 'enabled' : 'disabled (client passthrough)') + '.', 'success');
        }
        function renderProviderThinkingGrid() {
          const grid = document.getElementById('providerThinkingGrid');
          if (!grid) return;
          const providers = Array.isArray(thinkingConfig.providers) ? thinkingConfig.providers : [];
          if (providers.length === 0) {
            grid.innerHTML = '<div class="muted">No providers configured yet.</div>';
            return;
          }
          grid.innerHTML = providers.map(function(p) {
            const level = p.level || 'none';
            const isGlobal = level === (thinkingConfig.global || 'none');
            return '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="font-size:13px;font-weight:600;flex:1;">' + escapeHtml(p.name) + '</span>' +
              '<select data-thinking-provider="' + escapeHtml(p.name) + '" onchange="saveProviderThinkingLevel(this)" style="width:auto;min-width:120px;">' +
                '<option value=""' + (isGlobal ? ' selected' : '') + '>Global (' + escapeHtml(thinkingConfig.global || 'none') + ')</option>' +
                '<option value="none"' + (level === 'none' && !isGlobal ? ' selected' : '') + '>none</option>' +
                '<option value="low"' + (level === 'low' && !isGlobal ? ' selected' : '') + '>low</option>' +
                '<option value="medium"' + (level === 'medium' && !isGlobal ? ' selected' : '') + '>medium</option>' +
                '<option value="high"' + (level === 'high' && !isGlobal ? ' selected' : '') + '>high</option>' +
                '<option value="xhigh"' + (level === 'xhigh' && !isGlobal ? ' selected' : '') + '>xhigh</option>' +
              '</select>' +
            '</div>';
          }).join('');
        }
        async function saveThinkingLevel() {
          const levelSelect = document.getElementById('thinkingLevelSelect');
          const level = levelSelect ? levelSelect.value : 'none';
          const res = await fetch('/api/thinking-level', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ global: level })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to save thinking level.', 'error');
            return;
          }
          thinkingConfig = payload;
          renderProviderThinkingGrid();
          updateThinkingStatusText();
          setMessage('Global thinking level set to: ' + level, 'success');
        }
        async function saveProviderThinkingLevel(selectEl) {
          const provider = selectEl.getAttribute('data-thinking-provider');
          const level = selectEl.value;
          if (!level) {
            // Clear override
            const res = await fetch('/api/thinking-level/' + encodeURIComponent(provider), { method: 'DELETE' });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Failed to clear thinking override.', 'error');
              return;
            }
            thinkingConfig = payload;
            renderProviderThinkingGrid();
            setMessage('Cleared thinking override for ' + escapeHtml(provider), 'success');
            return;
          }
          const res = await fetch('/api/thinking-level', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, level })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to save thinking level.', 'error');
            return;
          }
          thinkingConfig = payload;
          renderProviderThinkingGrid();
          setMessage('Thinking level for ' + escapeHtml(provider) + ' set to: ' + level, 'success');
        }
        let waferZdrEnabled = true;
        async function loadWaferZdrConfig() {
          try {
            const res = await fetch('/api/wafer-config');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            waferZdrEnabled = Boolean(data.zdrEnabled);
            const toggleEl = document.getElementById('waferZdrToggle');
            const statusEl = document.getElementById('waferZdrStatus');
            if (toggleEl) toggleEl.checked = waferZdrEnabled;
            if (statusEl) statusEl.textContent = waferZdrEnabled ? 'ZDR active for GLM-5.1 and Kimi-K2.6' : 'ZDR disabled';
          } catch (err) {
            console.error('loadWaferZdrConfig failed:', err);
            const statusEl = document.getElementById('waferZdrStatus');
            if (statusEl) statusEl.textContent = 'Failed to load';
          }
        }
        async function toggleWaferZdr() {
          const toggleEl = document.getElementById('waferZdrToggle');
          const enabled = Boolean(toggleEl?.checked);
          const res = await fetch('/api/wafer-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zdrEnabled: enabled })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update ZDR config.', 'error');
            if (toggleEl) toggleEl.checked = !enabled;
            return;
          }
          waferZdrEnabled = payload.zdrEnabled;
          const statusEl = document.getElementById('waferZdrStatus');
          if (statusEl) statusEl.textContent = waferZdrEnabled ? 'ZDR active for GLM-5.1 and Kimi-K2.6' : 'ZDR disabled';
          setMessage('Wafer ZDR enhancement ' + (waferZdrEnabled ? 'enabled' : 'disabled') + '.', 'success');
        }
        let headroomEnabled = true;
        let headroomProxyUrl = 'http://localhost:8787';
        async function loadHeadroomConfig() {
          try {
            const res = await fetch('/api/headroom-config');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            headroomEnabled = Boolean(data.enabled);
            headroomProxyUrl = data.proxyUrl || 'http://localhost:8787';
            const toggleEl = document.getElementById('headroomToggle');
            const statusEl = document.getElementById('headroomStatus');
            const fieldsEl = document.getElementById('headroomFields');
            const urlInputEl = document.getElementById('headroomProxyUrlInput');
            if (toggleEl) toggleEl.checked = headroomEnabled;
            if (statusEl) statusEl.textContent = headroomEnabled ? 'Context compression active (' + escapeHtml(headroomProxyUrl) + ')' : 'Context compression disabled';
            if (fieldsEl) fieldsEl.style.display = headroomEnabled ? 'block' : 'none';
            if (urlInputEl) urlInputEl.value = headroomProxyUrl;
          } catch (err) {
            console.error('loadHeadroomConfig failed:', err);
            const statusEl = document.getElementById('headroomStatus');
            if (statusEl) statusEl.textContent = 'Failed to load';
          }
        }
        async function toggleHeadroom() {
          const toggleEl = document.getElementById('headroomToggle');
          const fieldsEl = document.getElementById('headroomFields');
          const enabled = Boolean(toggleEl?.checked);
          if (fieldsEl) fieldsEl.style.display = enabled ? 'block' : 'none';
          const res = await fetch('/api/headroom-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update Headroom config.', 'error');
            if (toggleEl) toggleEl.checked = !enabled;
            if (fieldsEl) fieldsEl.style.display = !enabled ? 'block' : 'none';
            return;
          }
          headroomEnabled = payload.enabled;
          const statusEl = document.getElementById('headroomStatus');
          if (statusEl) statusEl.textContent = headroomEnabled ? 'Context compression active (' + escapeHtml(headroomProxyUrl) + ')' : 'Context compression disabled';
          setMessage('Headroom context compression ' + (headroomEnabled ? 'enabled' : 'disabled') + '.', 'success');
        }
        async function saveHeadroomProxyUrl() {
          const urlInputEl = document.getElementById('headroomProxyUrlInput');
          const proxyUrl = urlInputEl?.value?.trim();
          if (!proxyUrl) {
            setMessage('Proxy URL cannot be empty.', 'error');
            return;
          }
          const res = await fetch('/api/headroom-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxyUrl })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update Headroom proxy URL.', 'error');
            return;
          }
          headroomProxyUrl = payload.proxyUrl;
          const statusEl = document.getElementById('headroomStatus');
          if (statusEl) statusEl.textContent = headroomEnabled ? 'Context compression active (' + escapeHtml(headroomProxyUrl) + ')' : 'Context compression disabled';
          setMessage('Headroom proxy URL updated successfully.', 'success');
        }
        async function toggleSystemPrompt() {
          const toggleEl = document.getElementById('systemPromptToggle');
          const fieldsEl = document.getElementById('systemPromptFields');
          const enabled = Boolean(toggleEl?.checked);
          if (fieldsEl) fieldsEl.style.display = enabled ? 'block' : 'none';
          const res = await fetch('/api/system-prompt', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update system prompt.', 'error');
            return;
          }
          const statusEl = document.getElementById('systemPromptStatus');
          if (statusEl) statusEl.textContent = payload.enabled ? 'Active — injecting into all requests' : 'Disabled';
          setMessage('System prompt ' + (payload.enabled ? 'enabled' : 'disabled') + '.', 'success');
        }
        async function saveSystemPrompt() {
          const textEl = document.getElementById('systemPromptText');
          const prompt = textEl ? textEl.value : '';
          const res = await fetch('/api/system-prompt', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to save system prompt.', 'error');
            return;
          }
          if (textEl) textEl.value = payload.prompt;
          setMessage('System prompt saved.', 'success');
        }
        async function resetSystemPromptToDefault() {
          const textEl = document.getElementById('systemPromptText');
          if (textEl) textEl.value = systemPromptDefault || '';
          const res = await fetch('/api/system-prompt', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: systemPromptDefault })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to reset system prompt.', 'error');
            return;
          }
          setMessage('System prompt reset to Chain of Draft default.', 'success');
        }

        async function syncPqcBundleKeys(force = false) {
          try {
            const res = await fetch('/api/pqc-resync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ force: Boolean(force) })
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              if (force) setMessage(payload?.error || 'PQC bundle sync failed (see server log).', 'error');
              return null;
            }
            if (force && payload?.resynced) {
              const count = Array.isArray(payload.loaded) ? payload.loaded.length : 0;
              setMessage('PQC bundle synced: ' + count + ' provider key(s) loaded' +
                (count > 0 ? ' (' + payload.loaded.join(', ') + ')' : '') + '.', 'success');
              await loadProviderConfigs();
            } else if (force) {
              setMessage('PQC bundle sync skipped (' + (payload?.reason || 'cooldown') + ').', 'success');
            }
            return payload;
          } catch (error) {
            if (force) setMessage('PQC bundle sync failed: ' + (error && error.message ? error.message : error), 'error');
            return null;
          }
        }

        async function loadProviderConfigs() {
          try {
            // Fire-and-rerender, never block the page: a cold uv cache can
            // hold the first bundle sync for up to a minute.
            syncPqcBundleKeys(false).then((payload) => {
              if (payload && payload.resynced && Array.isArray(payload.loaded) && payload.loaded.length > 0) {
                loadProviderConfigs();
              }
            });
            const res = await fetch('/api/provider-configs');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const payload = await res.json();
            providerConfigs = Array.isArray(payload?.data) ? payload.data : [];
            renderProviderSelection();
          } catch (err) {
            console.error('loadProviderConfigs failed:', err);
            const selectEl = document.getElementById('providerSelect');
            if (selectEl) {
              selectEl.innerHTML = '<option value="">Error loading providers — check console</option>';
            }
            renderProviderSelection();
          }
        }

        async function saveKeys() {
          const provider = document.getElementById('providerSelect').value;
          const keyInputEl = document.getElementById('providerKey');
          const apiKey = keyInputEl.value;

          if (provider === ADD_CUSTOM_PROVIDER_VALUE) {
            setMessage('Create the custom provider first, then save its API key.', 'error');
            return;
          }

          if (!provider || !apiKey) {
            setMessage('Select a provider and enter an API key before saving.', 'error');
            return;
          }

          const res = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey })
          });

          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
             setMessage(payload?.error || 'Failed to save provider key.', 'error');
             return;
          }

          keyInputEl.value = '';
          const discovered = payload?.discovered;
          if (discovered && discovered.count > 0) {
            const sourceLabels = { live: 'live upstream', registry: 'curated registry', catalog: 'static catalog' };
            setMessage('Provider key saved. Discovered ' + discovered.count + ' model(s) from ' +
              (sourceLabels[discovered.source] || discovered.source) +
              ' — all toggled off by default' +
              (discovered.deselectedCount > 0 ? ' (previous selection of ' + discovered.deselectedCount + ' backed up)' : '') +
              '. Check the few you want to serve below.', 'success');
          } else {
            setMessage('Provider key saved in-memory successfully.', 'success');
          }
          await loadProviderConfigs();
          await loadCatalog();
          if (discovered && discovered.count > 0) {
            scrollToProviderGroup(provider);
          }
          await loadFallbackRoutes();
        }

        async function resetProviderKey(providerName) {
          if (!providerName) return;

          const res = await fetch('/api/keys/' + encodeURIComponent(providerName), {
            method: 'DELETE'
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to reset provider key.', 'error');
            return;
          }

          document.getElementById('providerKey').value = '';
          setMessage('Cleared in-memory key for ' + providerName + '.', 'success');
          await loadProviderConfigs();
          await loadCatalog();
          await loadFallbackRoutes();
        }

        function saveProviderKey() {
          saveKeys();
        }

        async function resetSelectedProviderModels() {
          const provider = document.getElementById('providerSelect').value;
          if (!provider) return;

          const res = await fetch('/api/provider-models/' + encodeURIComponent(provider), {
            method: 'DELETE'
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to reset provider models.', 'error');
            return;
          }

          const selected = selectedProviderConfig();
          const resetLabel = selected?.isCustom ? 'custom provider model list cleared' : 'registry baseline';
          setMessage('Provider models reset to ' + resetLabel + '.', 'success');
          clearProviderModelForm();
          await loadProviderConfigs();
          await loadCatalog();
        }

        async function configureVSCodePicker() {
          const res = await fetch('/api/vscode/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to refresh VS Code model picker.', 'error');
            return;
          }

          setMessage('VS Code model picker refreshed. Reload the VS Code window if the dropdown is already open.', 'success');
        }

        // ── Per-provider model refresh (group header button) ──
        // One section per provider now: the catalog group list IS the
        // toggle/search surface; fetching live models refreshes that group's
        // cache section off-by-default, then the normal serving toggles
        // (auto-saved) apply — no second list, no second save button.
        async function refreshSingleProviderModels(provider) {
          if (!provider) return false;
          const sourceLabels = { live: 'live upstream', registry: 'curated registry', catalog: 'static catalog' };
          setMessage('Fetching live models for ' + provider + '…', 'success');
          try {
            const res = await fetch('/api/provider-models/' + encodeURIComponent(provider) + '/refresh', { method: 'POST' });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload?.error || 'Refresh failed');
            let note = provider + ': fetched ' + payload.count + ' model(s) — source: ' + (sourceLabels[payload.source] || payload.source) + '. All toggled off by default';
            if (payload.deselectedCount > 0) {
              note += ' (previous selection of ' + payload.deselectedCount + ' backed up)';
            }
            note += ' — check the few you want served (auto-saves).';
            if (payload.note) note += ' (' + payload.note + ')';
            await loadCatalog();
            scrollToProviderGroup(provider);
            setMessage(note, 'success');
            return true;
          } catch (err) {
            setMessage('Fetch failed for ' + provider + ': ' + (err && err.message ? err.message : err), 'error');
            return false;
          }
        }

        function scrollToProviderGroup(provider) {
          const group = document.querySelector('.provider-group[data-provider="' + CSS.escape(provider) + '"]');
          if (group) group.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Hand a model to the Fallback Routes page editor — all chain editing
        // lives there (the Providers page no longer carries a second editor).
        function stageModelOnFallbackPage(modelId) {
          if (!modelId) return;
          window.location.href = '/config/fallback?add=' + encodeURIComponent(modelId);
        }

        // On the Fallback Routes page: accept a model handed over from the
        // Providers & Models catalog ("＋ Fallback"). The system chain always
        // exists (empty by default), so a plain ?add= param persists immediately
        // via the same toggle API the old per-row checkbox used — no ≥2
        // gate, works from the very first model.
        async function stageModelFromQuery() {
          const selectEl = document.getElementById('fallbackRouteSelect');
          if (!selectEl) return;
          const params = new URLSearchParams(window.location.search);
          const addModel = String(params.get('add') || '').trim();
          if (!addModel) return;

          const rawChain = String(params.get('chain') || '').trim();
          const chainId = rawChain
            ? (rawChain.indexOf('local-router/') === 0 ? rawChain.substring('local-router/'.length) : rawChain)
            : 'fallback-models';
          const routes = Array.isArray(fallbackRoutes) ? fallbackRoutes : [];
          const ROUTE_PREFIX = 'local-router/';
          const routeOf = function(r) {
            const raw = String((r && (r.routeId || r.id)) || '');
            return raw.indexOf(ROUTE_PREFIX) === 0 ? raw.substring(ROUTE_PREFIX.length) : raw;
          };
          const targetRoute = routes.find(function(r) { return routeOf(r) === chainId; });

          if (targetRoute) {
            try {
              const res = await fetch('/api/fallback-chain/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: addModel, enabled: true, routeId: chainId })
              });
              const payload = await res.json().catch(() => ({}));
              if (!res.ok || !payload.success) throw new Error((payload && payload.error) || ('HTTP ' + res.status));
              await loadFallbackRoutes();
              selectEl.value = 'local-router/' + chainId;
              selectFallbackRouteToEdit(selectEl.value);
              setMessage('Added ' + addModel + ' to local-router/' + chainId + ' (saved). Reorder or disable steps below.', 'success');
            } catch (err) {
              setMessage('Failed to add ' + addModel + ' to local-router/' + chainId + ': ' + (err && err.message ? err.message : err), 'error');
            }
            window.history.replaceState({}, '', '/config/fallback');
            return;
          }

          // Chain not found → open the new-chain editor with the model
          // staged; non-system chains keep their existing 404 semantics.
          selectFallbackRouteToEdit(NEW_FALLBACK_CHAIN_VALUE);
          addFallbackCandidate(addModel);
          setMessage('Chain "local-router/' + chainId + '" does not exist — staged ' + addModel + ' in a new chain instead. Name it and add a second model to save.', 'error');
          const listEl = document.getElementById('fallbackCandidateList');
          if (listEl) listEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          window.history.replaceState({}, '', '/config/fallback');
        }

        let curationCatalogData = [];
        let curationSelectedKeys = new Set();
        let curationEnabled = false;
        const curationSearchByProvider = {};

        function catalogRowKey(provider, model) {
          return provider + '::' + model;
        }

        function totalCurationModelCount() {
          return curationCatalogData.reduce((total, group) => total + ((group && group.models) ? group.models.length : 0), 0);
        }

        function setCurationControlsVisible(visible) {
          const controlsEl = document.getElementById('curationControls');
          if (controlsEl) controlsEl.style.display = visible ? 'block' : 'none';
        }

        async function loadCurationCatalog() {
          const catalogEl = document.getElementById('catalog');
          const countEl = document.getElementById('catalogCount');
          try {
            const [servedRes, curationRes] = await Promise.all([
              fetch('/v1/models'),
              fetch('/api/model-curation')
            ]);
            const servedPayload = await servedRes.json().catch(() => ({}));
            const servedData = Array.isArray(servedPayload?.data) ? servedPayload.data : [];
            const payload = await curationRes.json();

            curationCatalogData = Array.isArray(payload?.data) ? payload.data : [];
            curationEnabled = Boolean(payload?.curationEnabled);
            curationSelectedKeys = new Set(Array.isArray(payload?.selectedKeys) ? payload.selectedKeys : []);

            // Off-by-default (2026-08-22): an empty selection is valid — it
            // serves only ollama + composites until the operator checks the
            // models they want. Never silently re-select everything.

            const toggleEl = document.getElementById('curationToggle');
            if (toggleEl) toggleEl.checked = curationEnabled;

            countEl.innerText = servedData.length + ' models served'
              + (curationEnabled
                ? ' (curated: ' + curationSelectedKeys.size + ' of ' + totalCurationModelCount() + ' ported)'
                : ' from ' + curationCatalogData.length + ' endpoint providers');
            renderCurationCatalog();
          } catch (error) {
            countEl.innerText = 'Unable to load curation catalog';
            catalogEl.innerHTML = '<div class="muted">The endpoint model curation catalog could not be loaded.</div>';
          }
        }

        // Per-provider key status merged into the catalog group headers (the
        // logical join of "Provider Key Configs" with "Available Providers &
        // Models"): pill + env var + a shortcut that opens this provider in
        // the key form above.
        // One section per provider: key status + key actions + live fetch +
        // custom-provider management all live here in the catalog group
        // header (the old separate "Provider Key Configs" grid is gone).
        function providerKeyStatusHtml(providerName) {
          if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
            return ' <button type="button" class="button-secondary" data-fetch-provider="' + escapeHtml(providerName) + '" style="padding: 1px 8px; font-size: 11px;" title="Fetch live /models for this provider (merged into this group, toggled off)">🔄 Fetch live</button>';
          }
          const cfg = providerConfigs.find(function(p) { return p && p.name === providerName; });
          if (!cfg) return '';
          const pill = cfg.configured
            ? '<span class="pill status-pill configured">Key configured</span>'
            : '<span class="pill status-pill pending">No key</span>';
          const envVar = cfg.keyEnvVar ? ' <span class="muted">' + escapeHtml(cfg.keyEnvVar) + '</span>' : '';
          const customActions = cfg.isCustom
            ? ' <button type="button" class="button-secondary" data-edit-custom="' + escapeHtml(cfg.name) + '" style="padding: 1px 8px; font-size: 11px;">Edit</button>'
            + ' <button type="button" class="button-secondary" data-delete-custom="' + escapeHtml(cfg.name) + '" style="padding: 1px 8px; font-size: 11px;">Delete</button>'
            : '';
          return '<span class="provider-key-status" style="font-size: 12px;">' + pill + envVar
            + ' <button type="button" class="button-secondary" data-configure-provider="' + escapeHtml(cfg.name) + '" style="padding: 1px 8px; font-size: 11px;">' + (cfg.configured ? 'Update key' : 'Configure key') + '</button>'
            + ' <button type="button" class="button-secondary" data-fetch-provider="' + escapeHtml(cfg.name) + '" style="padding: 1px 8px; font-size: 11px;" title="Fetch live /models for this provider (merged into this group, toggled off)">🔄 Fetch live</button>'
            + ' <button type="button" class="button-secondary" data-reset-provider="' + escapeHtml(cfg.name) + '" style="padding: 1px 8px; font-size: 11px;" title="Clear the in-memory key for this provider">Reset key</button>'
            + customActions
            + '</span>';
        }

        function openProviderKeyConfig(providerName) {
          if (!providerName) return;
          selectProvider(providerName);
          const keyInput = document.getElementById('providerKey');
          if (keyInput) {
            keyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            keyInput.focus();
          }
        }

        function setCurationProviderSearch(provider, value, caret) {
          curationSearchByProvider[provider] = value;
          renderCurationCatalog();
          const el = document.querySelector('[data-curation-provider="' + CSS.escape(provider) + '"]');
          if (el) {
            el.focus();
            const pos = Math.min(typeof caret === 'number' ? caret : el.value.length, el.value.length);
            el.setSelectionRange(pos, pos);
          }
        }

        function renderCurationCatalog() {
          const catalogEl = document.getElementById('catalog');
          const statusEl = document.getElementById('curationStatus');
          const searchEl = document.getElementById('catalogSearch');
          if (!catalogEl || !Array.isArray(curationCatalogData)) return;

          const search = String((searchEl && searchEl.value) || '').trim().toLowerCase();
          let shown = 0;
          let html = '';

          for (let p = 0; p < curationCatalogData.length; p++) {
            const group = curationCatalogData[p];
            const models = (group && Array.isArray(group.models)) ? group.models : [];
            const providerSearch = String(curationSearchByProvider[group.provider] || '').trim().toLowerCase();
            const matching = [];
            for (let m = 0; m < models.length; m++) {
              const model = models[m];
              const haystack = [model.id, model.display, model.model]
                .map((part) => String(part || '').toLowerCase())
                .join('\\n');
              if (search && !haystack.includes(search)) continue;
              if (providerSearch && !haystack.includes(providerSearch)) continue;
              matching.push(m);
            }
            // Global search prunes whole groups (legacy behavior); a
            // provider-local search keeps its section rendered so the user
            // can recover from a typo without the box vanishing.
            const prunedByGlobal = search && matching.length === 0;
            if (prunedByGlobal) continue;
            if (!search && !providerSearch && matching.length === 0) continue;

            const servedCount = models.filter(function(model) {
              return curationSelectedKeys.has(catalogRowKey(group.provider, model.model));
            }).length;
            html += '<section class="provider-group" data-provider="' + escapeHtml(group.provider) + '">'
              + '<h3>' + escapeHtml(group.provider) + ' <span class="muted">(' + matching.length + (matching.length !== models.length ? ' / ' + models.length : '') + ' · ' + servedCount + ' served)</span> ' + providerKeyStatusHtml(group.provider) + '</h3>'
              + '<input type="search" class="curation-provider-search" data-curation-provider="' + escapeHtml(group.provider) + '"'
              + ' placeholder="Search ' + escapeHtml(group.provider) + ' models…"'
              + ' value="' + escapeHtml(curationSearchByProvider[group.provider] || '') + '"'
              + ' oninput="setCurationProviderSearch(this.dataset.curationProvider, this.value, this.selectionStart)">'
              + '<ul class="model-list">';
            if (matching.length === 0) {
              html += '<li class="provider-model-empty">No models match this provider search.</li>';
            }
            for (const m of matching) {
              const model = models[m];
              const key = catalogRowKey(group.provider, model.model);
              const checked = curationSelectedKeys.has(key) ? ' checked' : '';
              html += '<li style="display: flex; gap: 12px; align-items: center;">'
                + '<label class="flag-toggle" style="display: flex; gap: 8px; align-items: flex-start; flex: 1;">'
                + '<input type="checkbox"' + checked + ' onchange="toggleCatalogRow(' + p + ', ' + m + ', this.checked)">'
                + '<span><strong>' + escapeHtml(model.id) + '</strong><br><span class="muted">' + escapeHtml(model.display || model.model || '') + '</span></span>'
                + '</label>'
                + '<button type="button" class="button-secondary" data-stage-fallback="' + escapeHtml(model.id) + '"'
                + ' title="Stage this model into a chain on the Fallback Routes page (all chain editing lives there)"'
                + ' style="padding: 1px 8px; font-size: 11px; white-space: nowrap;">＋ Fallback</button>'
                + '</li>';
              shown++;
            }
            html += '</ul></section>';
          }

          catalogEl.innerHTML = html
            || '<div class="muted">No ported endpoint models match. Use 🔄 Refresh Endpoints to port models from every provider.</div>';

          catalogEl.querySelectorAll('button[data-configure-provider]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              openProviderKeyConfig(btn.getAttribute('data-configure-provider') || '');
            });
          });
          catalogEl.querySelectorAll('button[data-fetch-provider]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              refreshSingleProviderModels(btn.getAttribute('data-fetch-provider') || '');
            });
          });
          catalogEl.querySelectorAll('button[data-reset-provider]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              resetProviderKey(btn.getAttribute('data-reset-provider') || '');
            });
          });
          catalogEl.querySelectorAll('button[data-edit-custom]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              openCustomProviderEditor(btn.getAttribute('data-edit-custom') || '');
            });
          });
          catalogEl.querySelectorAll('button[data-delete-custom]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              deleteCustomProvider(btn.getAttribute('data-delete-custom') || '');
            });
          });
          catalogEl.querySelectorAll('button[data-stage-fallback]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              stageModelOnFallbackPage(btn.getAttribute('data-stage-fallback') || '');
            });
          });

          if (statusEl) {
            statusEl.innerText = curationSelectedKeys.size + ' of ' + totalCurationModelCount() + ' models selected for serving'
              + (curationEnabled ? '' : ' (curation off — all ported models served)')
              + (shown > 0 ? ' — ' + shown + ' shown' : '');
          }
        }

        // Serving toggles persist like the fallback chain panel ("changes
        // save immediately"), 600ms debounced — an unsaved browser-side
        // selection silently lost on reload was the 2026-08-24 "checked but
        // nothing shows up in VS Code" report.
        let curationSaveTimer = null;

        function scheduleCurationAutoSave() {
          if (curationSaveTimer) clearTimeout(curationSaveTimer);
          const statusEl = document.getElementById('curationStatus');
          if (statusEl) statusEl.innerText = 'Saving curation selection…';
          curationSaveTimer = setTimeout(function() {
            curationSaveTimer = null;
            saveCuration({ silent: true });
          }, 600);
        }

        function toggleCatalogRow(pIdx, mIdx, checked) {
          const group = curationCatalogData[pIdx];
          const model = group && group.models ? group.models[mIdx] : null;
          if (!model) return;
          const key = catalogRowKey(group.provider, model.model);
          if (checked) {
            curationSelectedKeys.add(key);
          } else {
            curationSelectedKeys.delete(key);
          }
          renderCurationCatalog();
          scheduleCurationAutoSave();
        }

        function selectAllCatalog() {
          for (const group of curationCatalogData) {
            for (const model of (group.models || [])) {
              curationSelectedKeys.add(catalogRowKey(group.provider, model.model));
            }
          }
          renderCurationCatalog();
          scheduleCurationAutoSave();
        }

        // ── Named curation configs ──
        let curationConfigsCache = [];

        async function loadCurationConfigsList() {
          var selectEl = document.getElementById('curationConfigSelect');
          if (!selectEl) return;
          try {
            var res = await fetch('/api/curation-configs');
            var payload = await res.json().catch(() => ({}));
            curationConfigsCache = Array.isArray(payload?.data) ? payload.data : [];
          } catch (e) {
            curationConfigsCache = [];
          }
          var current = selectEl.value;
          selectEl.innerHTML = curationConfigsCache.length === 0
            ? '<option value="">(no saved configs)</option>'
            : curationConfigsCache.map(function(config) {
                var label = (config.isDefault ? '★ ' : '') + config.name + ' (' + config.count + ')';
                return '<option value="' + escapeHtml(config.name) + '">' + escapeHtml(label) + '</option>';
              }).join('');
          if (current && curationConfigsCache.some(function(c) { return c.name === current; })) {
            selectEl.value = current;
          }
          onCurationConfigSelected();
        }

        function onCurationConfigSelected() {
          var selectEl = document.getElementById('curationConfigSelect');
          var nameEl = document.getElementById('curationConfigName');
          if (!selectEl || !nameEl) return;
          if (selectEl.value) nameEl.value = selectEl.value;
        }

        async function saveCurationConfig() {
          var nameEl = document.getElementById('curationConfigName');
          var name = String((nameEl && nameEl.value) || '').trim();
          if (!name) {
            setMessage('Enter a config name first.', 'error');
            return;
          }
          try {
            var res = await fetch('/api/curation-configs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name, selectedKeys: Array.from(curationSelectedKeys) })
            });
            var payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Failed to save curation config.', 'error');
              return;
            }
            setMessage('Saved curation config "' + name + '" (' + (payload?.config?.count ?? curationSelectedKeys.size) + ' models).', 'success');
            await loadCurationConfigsList();
            var selectEl = document.getElementById('curationConfigSelect');
            if (selectEl) selectEl.value = name;
          } catch (e) {
            setMessage('Failed to save curation config: ' + String(e && e.message || e), 'error');
          }
        }

        async function loadCurationConfig() {
          var selectEl = document.getElementById('curationConfigSelect');
          var name = String((selectEl && selectEl.value) || '').trim();
          if (!name) {
            setMessage('Pick a saved config to load.', 'error');
            return;
          }
          try {
            var res = await fetch('/api/curation-configs/load', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name })
            });
            var payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Failed to load curation config.', 'error');
              return;
            }
            curationEnabled = true;
            curationSelectedKeys = new Set(Array.isArray(payload?.selectedKeys) ? payload.selectedKeys : []);
            renderCurationCatalog();
            await buildModelDropdown();
            setMessage('Loaded curation config "' + name + '" — ' + (payload?.selectedCount ?? curationSelectedKeys.size) + ' models now served.', 'success');
          } catch (e) {
            setMessage('Failed to load curation config: ' + String(e && e.message || e), 'error');
          }
        }

        async function deleteCurationConfig() {
          var selectEl = document.getElementById('curationConfigSelect');
          var name = String((selectEl && selectEl.value) || '').trim();
          if (!name) {
            setMessage('Pick a saved config to delete.', 'error');
            return;
          }
          if (!window.confirm('Delete curation config "' + name + '"?')) return;
          try {
            var res = await fetch('/api/curation-configs', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name })
            });
            var payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Failed to delete curation config.', 'error');
              return;
            }
            setMessage('Deleted curation config "' + name + '".', 'success');
            await loadCurationConfigsList();
          } catch (e) {
            setMessage('Failed to delete curation config: ' + String(e && e.message || e), 'error');
          }
        }

        async function setDefaultCurationConfig() {
          var selectEl = document.getElementById('curationConfigSelect');
          var name = String((selectEl && selectEl.value) || '').trim();
          if (!name) {
            setMessage('Pick a saved config to mark as default.', 'error');
            return;
          }
          try {
            var res = await fetch('/api/curation-configs/default', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name })
            });
            var payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Failed to set default config.', 'error');
              return;
            }
            setMessage('"' + name + '" is now the default curation config — applied at every server start.', 'success');
            await loadCurationConfigsList();
          } catch (e) {
            setMessage('Failed to set default config: ' + String(e && e.message || e), 'error');
          }
        }

        async function clearDefaultCurationConfig() {
          try {
            var res = await fetch('/api/curation-configs/default', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: null })
            });
            var payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Failed to clear default config.', 'error');
              return;
            }
            setMessage('Default curation config cleared.', 'success');
            await loadCurationConfigsList();
          } catch (e) {
            setMessage('Failed to clear default config: ' + String(e && e.message || e), 'error');
          }
        }

        function selectAllShownCatalog() {
          const searchEl = document.getElementById('catalogSearch');
          const search = String((searchEl && searchEl.value) || '').trim().toLowerCase();
          for (const group of curationCatalogData) {
            for (const model of (group.models || [])) {
              const haystack = [model.id, model.display, model.model]
                .map((part) => String(part || '').toLowerCase())
                .join('\\n');
              if (search && !haystack.includes(search)) continue;
              curationSelectedKeys.add(catalogRowKey(group.provider, model.model));
            }
          }
          renderCurationCatalog();
          scheduleCurationAutoSave();
        }

        function clearCatalogSelection() {
          curationSelectedKeys.clear();
          renderCurationCatalog();
          scheduleCurationAutoSave();
        }

        function toggleCuration(checked) {
          curationEnabled = Boolean(checked);
          renderCurationCatalog();
          scheduleCurationAutoSave();
        }

        async function saveCuration(options) {
          const silent = Boolean(options && options.silent);
          try {
            const res = await fetch('/api/model-curation', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                enabled: curationEnabled,
                selectedKeys: Array.from(curationSelectedKeys)
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(data?.error || 'Failed to save curation.', 'error');
              return;
            }
            curationEnabled = Boolean(data.curationEnabled);
            curationSelectedKeys = new Set(Array.isArray(data.selectedKeys) ? data.selectedKeys : curationSelectedKeys);
            if (silent) {
              const statusEl = document.getElementById('curationStatus');
              if (statusEl) statusEl.innerText = data.selectedCount + ' models saved for serving.';
            } else {
              setMessage('Model curation saved: ' + data.selectedCount + ' models will be served.', 'success');
              await loadCatalog();
              await buildModelDropdown();
            }
          } catch (e) {
            setMessage('Failed to save curation: ' + e.message, 'error');
          }
        }

        // Fallback chain editing lives exclusively on the Fallback Routes
        // page (2026-08-24 consolidation) — the Providers page only stages
        // models over to it via the per-model "＋ Fallback" button. The old
        // chain selector / order-panel JS for this page was removed with it.

        async function loadCatalog() {
          const catalogEl = document.getElementById('catalog');
          const countEl = document.getElementById('catalogCount');

          const descEl = document.getElementById('catalogDescription');
          if (descEl) {
            descEl.innerHTML = 'Search and check the models you want served; checks save automatically (Save Curation forces a refresh).';
          }

          setCurationControlsVisible(true);
          await loadCurationCatalog();
        }

        let filterConfigured = true;

        async function loadModelSource() {
          try {
            const res = await fetch('/api/model-source');
            const data = await res.json();
            if (typeof data.filterConfigured === 'boolean') {
              filterConfigured = data.filterConfigured;
            }
            const filterToggle = document.getElementById('filterConfiguredToggle');
            if (filterToggle) filterToggle.checked = filterConfigured;
            await loadCatalog();
          } catch (e) {
            console.error('Failed to load model source setting:', e);
          }
        }

        async function setFilterConfigured(checked) {
          try {
            const res = await fetch('/api/model-source', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filterConfigured: checked })
            });
            if (res.ok) {
              filterConfigured = checked;
              setMessage('Ollama proxy model filtering ' + (checked ? 'enabled' : 'disabled') + '.', 'success');
            }
          } catch (e) {
            setMessage('Failed to update filtering: ' + e.message, 'error');
          }
        }

        async function setModelSource(source) {
          // Compatibility shim: the Custom/Endpoint mode switch was removed
          // (single toggle catalog). No-op so stale callers don't error.
          setMessage('Model source switching was removed — the toggle catalog is always active.', 'info');
        }

        async function refreshEndpointModels() {
          const refreshBtn = document.getElementById('refreshEndpointsBtn');
          const countEl = document.getElementById('catalogCount');
          if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.innerText = '⏳ Refreshing...';
          }
          if (countEl) {
            countEl.innerText = 'Refreshing endpoint models...';
          }
          try {
            const res = await fetch('/api/refresh-endpoint-models', { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
              setMessage('Refreshed ' + data.count + ' models from provider endpoints — all toggled off by default' +
                (data.deselectedCount > 0 ? ' (' + data.deselectedCount + ' previously-selected keys backed up)' : '') +
                '.', 'success');
              await loadCatalog();
              await buildModelDropdown();
            } else {
              setMessage(data.error || 'Failed to refresh endpoint models.', 'error');
            }
          } catch (e) {
            setMessage('Failed to refresh: ' + e.message, 'error');
          } finally {
            if (refreshBtn) {
              refreshBtn.disabled = false;
              refreshBtn.innerText = '🔄 Refresh Endpoints';
            }
          }
        }

        function showUiError(context, err) {
          const msg = '[' + context + '] ' + (err && err.message ? err.message : String(err));
          console.error(msg, err);
          const listEl = document.getElementById('providerModelList');
          if (listEl && context === 'loadProviderConfigs') {
            listEl.innerHTML = '<div class="provider-model-empty" style="color: var(--danger-text);">Error: ' + msg + '</div>';
          }
          const fbListEl = document.getElementById('fallbackRouteList');
          if (fbListEl && context === 'loadFallbackRoutes') {
            fbListEl.innerHTML = '<div class="fallback-route-empty" style="color: var(--danger-text);">Error: ' + msg + '</div>';
          }
        }

        async function safeInit(name, fn) {
          try {
            await fn();
          } catch (err) {
            showUiError(name, err);
          }
        }

        initializeThemeScale();
        safeInit('hydrateOllamaVersionBadge', hydrateOllamaVersionBadge);
        safeInit('loadProviderConfigs', loadProviderConfigs);
        safeInit('loadFallbackRoutes', loadFallbackRoutes);
        safeInit('loadCurationConfigsList', loadCurationConfigsList);
        try { buildModelDropdown(); } catch (err) { showUiError('buildModelDropdown', err); }
        safeInit('loadCatalog', loadCatalog);
        // Fallback Routes page only: absorb a model staged from the catalog.
        safeInit('stageModelFromQuery', stageModelFromQuery);
        safeInit('loadProviderPricingPanel', loadProviderPricingPanel);
        loadSessionsPanel();
        loadSystemPrompt();
        loadThinkingConfig();
        loadWaferZdrConfig();
        loadHeadroomConfig();
        loadModelSource();

        async function loadProviderPricingPanel() {
          var countEl = document.getElementById('pricingCount');
          var listEl = document.getElementById('pricingList');
          try {
            var res = await fetch('/api/provider-pricing');
            var data = await res.json().catch(function() { return {}; });
            var models = data.models && typeof data.models === 'object' ? data.models : {};
            var keys = Object.keys(models).sort();
            countEl.innerText = keys.length + ' pricing override' + (keys.length === 1 ? '' : 's');
            if (!keys.length) {
              listEl.innerHTML = '<div class="fallback-route-empty">No pricing overrides configured.</div>';
              return;
            }
            listEl.innerHTML = keys.map(function(modelId) {
              var entry = models[modelId] || {};
              var until = entry.validUntil ? ' until ' + escapeHtml(entry.validUntil) : '';
              return '<div class="fallback-route-item">' +
                '<h4>' + escapeHtml(modelId) + '</h4>' +
                '<div class="meta">Input: $' + escapeHtml(String(entry.inputPricePerM)) + '/M | Output: $' + escapeHtml(String(entry.outputPricePerM)) + '/M' + until + '</div>' +
                '<div class="meta">' + escapeHtml(entry.label || '') + '</div>' +
                '<div class="actions">' +
                  '<button class="button-secondary" data-edit-pricing="' + escapeHtml(modelId) + '">Edit</button>' +
                '</div>' +
              '</div>';
            }).join('');
            listEl.querySelectorAll('button[data-edit-pricing]').forEach(function(button) {
              button.addEventListener('click', function() {
                var modelId = button.getAttribute('data-edit-pricing') || '';
                var entry = models[modelId] || {};
                document.getElementById('pricingModelId').value = modelId;
                document.getElementById('pricingInput').value = entry.inputPricePerM ?? '';
                document.getElementById('pricingOutput').value = entry.outputPricePerM ?? '';
                document.getElementById('pricingLabel').value = entry.label || '';
                document.getElementById('pricingValidUntil').value = entry.validUntil || '';
              });
            });
          } catch (e) {
            countEl.innerText = 'Error';
            listEl.innerHTML = '<div class="fallback-route-empty">Failed to load pricing: ' + escapeHtml(String(e.message || e)) + '</div>';
          }
        }

        function clearProviderPricingForm() {
          document.getElementById('pricingModelId').value = '';
          document.getElementById('pricingInput').value = '';
          document.getElementById('pricingOutput').value = '';
          document.getElementById('pricingLabel').value = '';
          document.getElementById('pricingValidUntil').value = '';
        }

        async function saveProviderPricingEntry() {
          var modelId = document.getElementById('pricingModelId').value.trim();
          var inputPricePerM = Number.parseFloat(document.getElementById('pricingInput').value);
          var outputPricePerM = Number.parseFloat(document.getElementById('pricingOutput').value);
          if (!modelId || !Number.isFinite(inputPricePerM) || !Number.isFinite(outputPricePerM)) {
            setMessage('Enter model ID, input $/M, and output $/M.', 'error');
            return;
          }
          var res = await fetch('/api/provider-pricing/' + encodeURIComponent(modelId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inputPricePerM: inputPricePerM,
              outputPricePerM: outputPricePerM,
              label: document.getElementById('pricingLabel').value.trim(),
              validUntil: document.getElementById('pricingValidUntil').value.trim() || undefined
            })
          });
          var payload = await res.json().catch(function() { return {}; });
          if (!res.ok) {
            setMessage(payload.error || 'Failed to save pricing.', 'error');
            return;
          }
          setMessage('Saved pricing for ' + modelId + '.', 'success');
          await loadProviderPricingPanel();
        }

        // ── Sessions & Feedback ──
        async function loadSessionsPanel() {
          var countEl = document.getElementById('sessionCount');
          var listEl = document.getElementById('sessionList');
          try {
            var res = await fetch('/api/sessions');
            var data = await res.json();
            var sessions = Array.isArray(data.sessions) ? data.sessions : [];
            countEl.innerText = sessions.length + ' session' + (sessions.length === 1 ? '' : 's');
            if (!sessions.length) {
              listEl.innerHTML = '<div class="fallback-route-empty">No recent sessions. CLI agents will appear here when they connect with X-Local-Router-Client header.</div>';
              return;
            }
            listEl.innerHTML = sessions.map(function(s) {
              var models = Object.keys(s.modelUsage || {}).map(function(m) {
                return m + ' (' + s.modelUsage[m] + ')';
              }).join(', ');
              var started = new Date(s.startedAt).toLocaleString();
              var last = new Date(s.lastActivity).toLocaleString();
              return '<div class="fallback-route-item">' +
                '<h4>' + escapeHtml(s.clientName) + ' <span class="provider-badge">session</span></h4>' +
                '<div class="meta">Started: ' + escapeHtml(started) + ' | Last activity: ' + escapeHtml(last) + '</div>' +
                '<div class="meta">Requests: ' + s.totalRequests + ' | Models: ' + escapeHtml(models || 'none') + '</div>' +
                '<div class="meta">ID: ' + escapeHtml(s.sessionId) + '</div>' +
                '<div class="actions">' +
                  '<button class="button-secondary" onclick="rateSession(\\'' + escapeHtml(s.sessionId).replace(/'/g, "\\\\'") + '\\', \\'up\\')" style="background:var(--success-bg);color:var(--success-text);">👍 Helpful</button>' +
                  '<button class="button-secondary" onclick="rateSession(\\'' + escapeHtml(s.sessionId).replace(/'/g, "\\\\'") + '\\', \\'down\\')" style="background:var(--danger-bg, #fde8e8);color:var(--danger-text);">👎 Not Helpful</button>' +
                '</div>' +
              '</div>';
            }).join('');
          } catch (e) {
            countEl.innerText = 'Error';
            listEl.innerHTML = '<div class="fallback-route-empty">Failed to load sessions: ' + escapeHtml(String(e.message || e)) + '</div>';
          }
        }

        async function rateSession(sessionId, rating) {
          try {
            var res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rating: rating })
            });
            var data = await res.json();
            if (res.ok) {
              setMessage('Session rated ' + (rating === 'up' ? '👍 helpful' : '👎 not helpful') + '. Thanks for the feedback!', 'success');
            } else {
              setMessage(data.error || 'Failed to rate session.', 'error');
            }
          } catch (e) {
            setMessage('Failed to rate session: ' + String(e.message || e), 'error');
          }
        }
        refreshDiagnostics();

        async function loadOAuthProviders() {
          const listEl = document.getElementById('oauthProviderList');
          if (!listEl) return;
          const oauthProviders = ['antigravity', 'github-copilot'];
          const rows = await Promise.all(oauthProviders.map(async (name) => {
            try {
              const res = await fetch('/api/oauth/status/' + encodeURIComponent(name));
              const status = res.ok ? await res.json() : null;
              return { name, status };
            } catch {
              return { name, status: null };
            }
          }));
          listEl.innerHTML = rows.map(({ name, status }) => {
            const configured = status?.configured;
            const pending = status?.pendingDeviceCode;
            const accountLabel = status?.accountLabel || 'not signed in';
            let html = '<section class="provider-card' + (configured ? ' active' : '') + '">' +
              '<h4>' + escapeHtml(status?.displayName || name) + '</h4>' +
              '<div class="muted">Account: ' + escapeHtml(accountLabel) + '</div>' +
              '<div class="muted">Auth: ' + escapeHtml(status?.authType || '') + '</div>';
            if (pending) {
              html += '<div class="pill status-pill pending">Pending device code: ' + escapeHtml(pending.userCode) + '</div>' +
                '<div class="muted">Enter this code at ' + escapeHtml(pending.verificationUri) + '</div>';
            }
            if (configured) {
              html += '<div class="pill status-pill configured">Logged in</div>' +
                '<div class="row row-actions">' +
                  '<button data-oauth-logout="' + escapeHtml(name) + '">Log out</button>' +
                '</div>';
            } else {
              html += '<div class="pill status-pill pending">Not logged in</div>' +
                '<div class="row row-actions">' +
                  '<button data-oauth-login="' + escapeHtml(name) + '">Log in with ' + escapeHtml(status?.displayName || name) + '</button>' +
                '</div>';
            }
            html += '</section>';
            return html;
          }).join('');
          listEl.querySelectorAll('button[data-oauth-login]').forEach((button) => {
            button.addEventListener('click', async () => {
              const provider = button.getAttribute('data-oauth-login') || '';
              try {
                const res = await fetch('/api/oauth/login/' + encodeURIComponent(provider), { method: 'POST' });
                const payload = await res.json();
                if (!res.ok) throw new Error(payload?.error || 'Login failed');
                if (payload.authUrl) {
                  const popup = window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
                  if (!popup) {
                    // Popup blocked - show clickable link in message
                    const messageEl = document.getElementById('message');
                    const linkText = 'Click here to open the login page in a new tab';
                    messageEl.innerHTML = 'Popup blocked. <a href="' + escapeHtml(payload.authUrl) + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>';
                    messageEl.style.display = 'block';
                  } else {
                    setMessage('Opened login page in a new tab. Complete the flow in your browser.', 'success');
                  }
                }
                if (payload.userCode) {
                  setMessage('Enter code ' + payload.userCode + ' at ' + payload.verificationUri + '. Waiting for authorization...', 'success');
                }
                const poll = setInterval(async () => {
                  const statusRes = await fetch('/api/oauth/status/' + encodeURIComponent(provider));
                  const statusPayload = await statusRes.json();
                  if (statusPayload.configured) {
                    clearInterval(poll);
                    setMessage('Logged in to ' + (statusPayload.displayName || provider) + ' successfully.', 'success');
                    loadOAuthProviders();
                  }
                }, 2000);
                setTimeout(() => clearInterval(poll), 5 * 60_000);
              } catch (err) {
                setMessage(err?.message || 'Login failed.', 'error');
              }
            });
          });
          listEl.querySelectorAll('button[data-oauth-logout]').forEach((button) => {
            button.addEventListener('click', async () => {
              const provider = button.getAttribute('data-oauth-logout') || '';
              const res = await fetch('/api/oauth/credentials/' + encodeURIComponent(provider), { method: 'DELETE' });
              const payload = await res.json().catch(() => ({}));
              if (!res.ok) {
                setMessage(payload?.error || 'Logout failed.', 'error');
                return;
              }
              setMessage('Logged out of ' + provider + '.', 'success');
              loadOAuthProviders();
            });
          });
        }

        (async () => { await loadOAuthProviders(); })();

  </script>
</body>
</html>`;
}
