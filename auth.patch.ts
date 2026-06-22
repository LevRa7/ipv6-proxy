// Fixed auth check: accepts X-Api-Key OR Authorization: Bearer
function checkAuth(headers: http.IncomingHttpHeaders): boolean {
  if (!REQUIRE_API_KEY) return true;

  // Check X-Api-Key
  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim() === API_KEY) {
    delete headers["x-api-key"];
    return true;
  }

  // Check Authorization: Bearer
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token === API_KEY) {
      delete headers["authorization"];
      return true;
    }
  }

  return false;
}
