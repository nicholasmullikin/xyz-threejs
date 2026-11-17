module.exports = `
#earth-controls{--surface:rgba(18,25,30,.96);--line:#ffffff18;--muted:#9cabb3;--accent:#c0e6ce;position:absolute;inset:0;z-index:50;pointer-events:none;color:#edf2f4;font:13px/1.45 system-ui,sans-serif}
#earth-controls *{box-sizing:border-box}
#earth-controls button,#earth-controls select,#earth-controls input{font:inherit}
#earth-controls button,#earth-controls select{color:inherit;border:1px solid var(--line);background:#ffffff06;cursor:pointer;border-radius:8px;min-height:40px}
#earth-controls button{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:8px 12px}
#earth-controls button:hover,#earth-controls select:hover{background:#ffffff12}
#earth-controls button:focus-visible,#earth-controls select:focus-visible,#earth-controls input:focus-visible,#earth-credits summary:focus-visible{outline:2px solid #c0e6ce;outline-offset:3px}
#earth-controls svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
#earth-controls [hidden]{display:none!important}
#earth-controls .earth-bar{pointer-events:auto;position:absolute;top:16px;left:16px;display:flex;align-items:center;padding:5px;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 20px #0003}
#earth-controls .earth-bar button{border-color:transparent}
#earth-controls .earth-home{border-right:1px solid var(--line)!important;border-radius:7px 0 0 7px;font-weight:650;letter-spacing:.02em;padding-right:16px}
#earth-controls .earth-bar button[aria-expanded=true]{background:#c0e6ce1b;color:var(--accent)}
#earth-controls .earth-drawer{pointer-events:auto;position:absolute;top:78px;left:16px;width:304px;max-height:calc(100% - 112px);overflow:auto;overscroll-behavior:contain;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px #0003;scrollbar-width:thin;scrollbar-color:#52616a transparent}
#earth-controls .earth-heading{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px}
#earth-controls h2{font-size:15px;font-weight:600;margin:0}
#earth-controls .earth-heading button{min-height:32px;width:32px;padding:6px;border:0}
#earth-controls section{padding:16px 18px;border-top:1px solid var(--line)}
#earth-controls h3{margin:0 0 12px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600}
#earth-controls .earth-destinations{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#earth-controls .earth-destination:last-child{grid-column:1/-1;min-height:64px}
#earth-controls select:disabled{opacity:.45;cursor:default}
#earth-controls .earth-destination{min-height:70px;display:flex;align-items:flex-start;flex-direction:column;gap:3px;text-align:left;padding:12px}
#earth-controls small{font-size:11px;color:var(--muted);font-weight:400}
#earth-controls label{display:block;color:var(--muted);font-size:12px;margin-bottom:6px}
#earth-controls select{display:block;width:100%;padding:8px 10px;background-color:#202a31;color:#edf2f4}
#earth-controls .earth-field+.earth-field{margin-top:12px}
#earth-controls .earth-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
#earth-controls .earth-switch-row+.earth-switch-row{margin-top:12px}
#earth-controls .earth-switch{padding:0;min-height:28px;height:28px;width:46px;border-radius:20px;position:relative;background:#4b555c;border:0;flex-shrink:0}
#earth-controls .earth-switch::after{content:'';width:20px;height:20px;position:absolute;left:4px;top:4px;border-radius:50%;background:#e7edef;transition:transform .15s}
#earth-controls .earth-switch[aria-pressed=true]{background:#83b696}
#earth-controls .earth-switch[aria-pressed=true]::after{transform:translateX(18px);background:#122c1b}
#earth-controls .earth-switch-row span{display:flex;flex-direction:column}
#earth-controls .earth-sun-actions{display:flex;gap:6px;margin-top:12px}
#earth-controls .earth-sun-actions button{flex:1}
#earth-controls output{font-variant-numeric:tabular-nums;color:#edf2f4;font-size:15px}
#earth-controls input[type=range]{width:100%;margin:10px 0 0;accent-color:#c0e6ce;cursor:pointer;min-height:28px}
#earth-controls .earth-help{padding:12px 18px;color:var(--muted);font-size:11px;border-top:1px solid var(--line)}
#earth-controls .earth-fullscreen{position:absolute;right:16px;top:16px;pointer-events:auto;background:var(--surface);width:46px;height:46px;box-shadow:0 4px 20px #0003}
#earth-controls .earth-status{position:absolute;bottom:28px;left:16px;max-width:280px;background:var(--surface);padding:10px 14px;border-radius:8px;pointer-events:auto}
#earth-navigation{position:absolute!important;top:auto!important;bottom:40px!important;right:16px!important;height:auto!important;width:44px!important;pointer-events:none}
#earth-navigation .harp-gl_v-align{display:none!important}
#earth-navigation .harp-gl_v-aligned{display:flex!important;flex-direction:column;gap:0;vertical-align:initial!important}
#earth-navigation .harp-gl_controls-button{margin:0!important;width:44px!important;height:44px!important;line-height:44px!important;border:1px solid #ffffff18!important;border-radius:0!important;background:rgba(18,25,30,.96)!important;box-shadow:none!important;font:600 18px system-ui!important;color:#edf2f4!important;pointer-events:auto}
#earth-navigation .harp-gl_controls-button:hover{background:#34434c!important}
#earth-navigation .harp-gl_controls-button:focus-visible{outline:2px solid #c0e6ce;outline-offset:2px;z-index:1}
#earth-navigation .harp-gl_controls-button:first-child{border-radius:10px 10px 0 0!important}
#earth-navigation .harp-gl_controls-button:last-child{border-radius:0 0 10px 10px!important;font-size:12px!important}
#earth-credits{position:absolute;bottom:4px;right:8px;z-index:51;max-width:min(340px,calc(100% - 16px));background:#12191ee8;color:#aab7bf;font:10px/1.5 system-ui;padding:3px 7px;border-radius:4px}
#earth-credits summary{cursor:pointer;list-style:none}#earth-credits a{color:#c0e6ce}#earth-credits[open]{padding:10px 12px}#earth-credits[open] summary{margin-bottom:8px}
@media(max-width:480px){#earth-controls .earth-bar{top:10px;left:10px;gap:0}#earth-controls .earth-bar button{padding:8px 10px}#earth-controls .earth-home span{display:none}#earth-controls .earth-fullscreen{top:10px;right:10px;width:42px;height:46px}#earth-controls .earth-drawer{top:72px;left:10px;width:min(304px,calc(100% - 72px));max-height:calc(100% - 104px)}#earth-navigation{right:10px!important}#earth-controls section{padding:14px}#earth-controls .earth-heading{padding:12px 14px 8px}}
@media(prefers-reduced-motion:reduce){#earth-controls .earth-switch::after{transition:none}}
`;
