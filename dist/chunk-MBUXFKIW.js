import{a as n}from"./chunk-EI7MMDWY.js";function o(e,t){let r=e.context===void 0?"":`

${e.context}`;return`[SYSTEM] ${e.toolName} blocked: ${e.field} anchor "${e.anchor}" is stale. If the required line is represented by one of the context lines below, use that anchor. Otherwise, reread only the relevant section of "${e.path}" and regenerate the anchor. (${t})${r}`}n(o,"formatStaleAnchorMessage");export{o as a};
