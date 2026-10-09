const titles = ["Ghidra Notes", "Electron Handbook", "Native Calls"];

function normalizeQuery(query) {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

function searchCatalog(query) {
  const normalized = normalizeQuery(query);
  if (normalized.length < 3) return [];
  return titles.filter((title) => title.toLowerCase().includes(normalized));
}

module.exports = { normalizeQuery, searchCatalog };
