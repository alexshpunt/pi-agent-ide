/** Assertions over the readable text emitted by real tools in scripted Codemode tests. */
export const textResultChecks = String.raw`
function check(condition, message) { if (!condition) throw Error(message); }
function body(result) { return result.slice(result.indexOf("\n") + 1); }
function uuid(result) { const id=/<uuid>([^<]+)<\/uuid>/.exec(result)?.[1]; check(id,"Missing result UUID"); return id; }
function items(result) {
 return [...result.matchAll(/^(RESULT#\S+) (.*):(\d+):(\d+)–(\d+):(\d+)(?: .*)?$/gm)].map(hit=>({
  ref:hit[1], source:hit[2], location:hit.slice(2,7).join(":"),
  startLine:Number(hit[3]), startColumn:Number(hit[4]), endLine:Number(hit[5]), endColumn:Number(hit[6])
 }));
}
function matches(result) { return [...new Set(result.match(/SEARCH#[A-F\d]+:\d+:match/g) ?? [])]; }
function matchRows(result) {
 return result.split(String.fromCharCode(10)).flatMap(row=>{
  const hit=/^(.+):(\d+):(\d+)-(\d+) (SEARCH#[A-F\d]+:\d+):line/.exec(row);
  if(hit) return [{ref:hit[5]+":match",source:hit[1],line:Number(hit[2]),column:Number(hit[3])-1,endColumn:Number(hit[4])-1}];
  const ast=/^(SEARCH#[A-F\d]+:\d+:match) (.+):(\d+):(\d+) /.exec(row);
  return ast ? [{ref:ast[1],source:ast[2],line:Number(ast[3]),column:Number(ast[4])-1}] : [];
 });
}
function capture(result, name) { return [...result.matchAll(new RegExp("capture " + name + ": (RESULT#[^\\s]+)","g"))].map(hit=>hit[1]); }
async function rejects(call, pattern) {
 try { await call(); } catch(error) { if(pattern) check(pattern.test(String(error)),"Unexpected refusal: "+error); return String(error); }
 throw Error("Unsafe operation succeeded");
}
`;

/** Keep Codemode's option directive first when adding sandbox assertions. */
export function withTextResultChecks(code: string): string {
  const directive = /^\/\/ @options:[^\n]*(?:\n|$)/u.exec(code)?.[0] ?? "";
  return directive + textResultChecks + code.slice(directive.length);
}
