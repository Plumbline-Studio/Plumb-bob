// Order page wiring: price lookup for the chosen catalog item.
//
// FIXTURE DIVERGENCE (intentional): submitting routes through an extra
// newsletter interstitial (newsletter.html) before the confirmation — the
// playscript expects confirmation immediately after submission. The flow
// still completes; the behavior merely differs from the script.
const PRICES = {
  classic: { name: "Lantern Classic", price: 29 },
  pro: { name: "Lantern Pro", price: 49 },
};
const params = new URLSearchParams(location.search);
const item = PRICES[params.get("item")] ? params.get("item") : "classic";
document.getElementById("item-name").textContent = PRICES[item].name;
document.getElementById("unit-price").textContent = `$${PRICES[item].price.toFixed(2)}`;

document.getElementById("place-order").addEventListener("click", () => {
  const name = document.getElementById("name").value || "Guest";
  const qty = Math.max(1, Number(document.getElementById("qty").value) || 1);
  const next = new URLSearchParams({ item, qty: String(qty), name });
  location.href = `newsletter.html?${next.toString()}`;
});
