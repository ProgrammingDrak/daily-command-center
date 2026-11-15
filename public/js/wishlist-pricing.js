(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WishlistPricing = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  const components = ["price", "shipping", "taxes", "discount", "extras"];
  function total(offer) {
    if (!offer.currency || components.some(key => offer[key] == null || offer[key] === "")) return null;
    const amounts = components.map(key => offer[key].split("."));
    const precision = Math.max(...amounts.map(([, decimal]) => (decimal || "").length));
    const values = amounts.map(([whole, decimal = ""]) => BigInt(whole + decimal.padEnd(precision, "0")));
    const [price, shipping, taxes, discount, extras] = values;
    const sum = price + shipping + taxes + extras - discount;
    const digits = (sum < 0n ? -sum : sum).toString().padStart(precision + 1, "0");
    const sign = sum < 0n ? "-" : "";
    return sign + (precision ? digits.slice(0, -precision) + "." + digits.slice(-precision) : digits);
  }
  function stale(checkedOn, now = Date.now()) {
    return !checkedOn || now - Date.parse(checkedOn) >= 30 * 24 * 60 * 60 * 1000;
  }
  function requirement(criterion, assessment) {
    if (criterion.importance !== "Must-have") return "";
    if (assessment?.verdict === "Fails") return "Failed must-have";
    if (assessment?.verdict === "Partly meets") return "Must-have partly met";
    if (!assessment?.verdict || assessment.verdict === "Unverified") return "Must-have unverified";
    return "";
  }
  return { total, stale, requirement };
});
