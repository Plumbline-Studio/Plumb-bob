// Order page wiring: price lookup for the chosen catalog item.
//
// FIXTURE DEFECT (intentional): the Place Order click handler is missing —
// as if a refactor dropped the listener wiring. Clicking the button does
// nothing, so the money path can never reach confirm.html.
// tests/harness-fixtures.test.ts guards that this file stays broken.
const PRICES = {
  classic: { name: "Lantern Classic", price: 29 },
  pro: { name: "Lantern Pro", price: 49 },
};
const params = new URLSearchParams(location.search);
const item = PRICES[params.get("item")] ? params.get("item") : "classic";
document.getElementById("item-name").textContent = PRICES[item].name;
document.getElementById("unit-price").textContent = `$${PRICES[item].price.toFixed(2)}`;
