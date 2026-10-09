document.querySelector("#search").addEventListener("click", async () => {
  const query = document.querySelector("#query").value;
  const matches = await window.catalog.search(query);
  document.querySelector("#results").textContent = matches.join("\n");
});
