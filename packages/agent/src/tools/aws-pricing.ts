/**
 * AWS EC2 on-demand pricing via the public AWS Bulk Pricing JSON endpoint.
 * No AWS credentials required — fully public API.
 */
import axios from "axios";

const PRICING_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current";

// Cache: region -> { instanceType: monthlyUsd }
const priceCache = new Map<string, Record<string, number>>();
// In-flight deduplication: region -> pending fetch promise.
// Prevents 12 concurrent batches from all firing the same region fetch simultaneously.
const pendingFetches = new Map<string, Promise<Record<string, number>>>();

async function fetchRegionPrices(region: string): Promise<Record<string, number>> {
  const url = `${PRICING_BASE}/${region}/index.json`;
  console.log(`[aws-pricing] Fetching EC2 pricing for ${region}`);

  const resp = await axios.get<{
    products: Record<string, { attributes: Record<string, string> }>;
    terms: { OnDemand: Record<string, Record<string, { priceDimensions: Record<string, { pricePerUnit: { USD: string } }> }>> };
  }>(url, { timeout: 60000 });

  const products = resp.data.products;
  const terms = resp.data.terms.OnDemand;

  const skuToInstance: Record<string, string> = {};
  for (const [sku, product] of Object.entries(products)) {
    const attrs = product.attributes;
    if (
      attrs.operatingSystem === "Linux" &&
      attrs.tenancy === "Shared" &&
      attrs.capacitystatus === "Used" &&
      attrs.preInstalledSw === "NA" &&
      attrs.instanceType
    ) {
      skuToInstance[sku] = attrs.instanceType;
    }
  }

  const prices: Record<string, number> = {};
  for (const [sku, instanceType] of Object.entries(skuToInstance)) {
    const offer = terms[sku] ?? {};
    for (const term of Object.values(offer)) {
      for (const dim of Object.values(term.priceDimensions)) {
        const usdPerHour = parseFloat(dim.pricePerUnit.USD ?? "0");
        if (usdPerHour > 0) {
          const monthly = Math.round(usdPerHour * 730 * 100) / 100;
          if (!(instanceType in prices) || monthly < prices[instanceType]) {
            prices[instanceType] = monthly;
          }
        }
      }
    }
  }

  console.log(`[aws-pricing] Loaded ${Object.keys(prices).length} prices for ${region}`);
  return prices;
}

async function getRegionPrices(region: string): Promise<Record<string, number>> {
  // Return immediately if already cached
  if (priceCache.has(region)) return priceCache.get(region)!;

  // Deduplicate concurrent fetches for the same region:
  // all callers that arrive while a fetch is in-flight share the same promise.
  if (!pendingFetches.has(region)) {
    const fetch = fetchRegionPrices(region)
      .then((prices) => {
        priceCache.set(region, prices);
        pendingFetches.delete(region);
        return prices;
      })
      .catch((e) => {
        console.error(`[aws-pricing] Failed to fetch pricing for ${region}:`, e);
        priceCache.set(region, {});
        pendingFetches.delete(region);
        return {} as Record<string, number>;
      });
    pendingFetches.set(region, fetch);
  }
  return pendingFetches.get(region)!;
}

export async function getInstanceOnDemandPrice(
  instanceType: string,
  region = "us-east-1"
): Promise<number | null> {
  const prices = await getRegionPrices(region);
  return prices[instanceType] ?? null;
}

export async function getPricesForInstances(
  instanceTypes: string[],
  region = "us-east-1"
): Promise<Record<string, number>> {
  const prices = await getRegionPrices(region);
  return Object.fromEntries(
    instanceTypes.filter((t) => t in prices).map((t) => [t, prices[t]])
  );
}
