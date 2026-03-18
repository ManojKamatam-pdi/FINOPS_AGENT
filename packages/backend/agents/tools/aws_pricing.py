"""
AWS EC2 on-demand pricing via the public AWS Bulk Pricing JSON endpoint.
No AWS credentials required — this is a fully public API.

Endpoint: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/{region}/index.json

The region JSON is fetched once per process and cached in memory.
Typical size: ~30-50 MB per region. Parsed once, lookups are O(1) dict access.
"""
import logging
import threading
import httpx

logger = logging.getLogger(__name__)

_PRICING_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current"

# Cache: region -> {instance_type: monthly_usd}
_price_cache: dict[str, dict[str, float]] = {}
_cache_lock = threading.Lock()


def _fetch_region_prices(region: str) -> dict[str, float]:
    """
    Download and parse the public AWS EC2 pricing JSON for a region.
    Returns {instance_type: monthly_usd} for Linux on-demand shared tenancy.
    """
    url = f"{_PRICING_BASE}/{region}/index.json"
    logger.info(f"Fetching EC2 pricing for {region} from public endpoint")

    resp = httpx.get(url, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    data = resp.json()

    products = data.get("products", {})
    terms = data.get("terms", {}).get("OnDemand", {})

    # Build SKU -> instance_type map for Linux/Shared/Used/NA products
    sku_to_instance: dict[str, str] = {}
    for sku, product in products.items():
        attrs = product.get("attributes", {})
        if (
            attrs.get("operatingSystem") == "Linux"
            and attrs.get("tenancy") == "Shared"
            and attrs.get("capacitystatus") == "Used"
            and attrs.get("preInstalledSw") == "NA"
            and attrs.get("instanceType")
        ):
            sku_to_instance[sku] = attrs["instanceType"]

    # Extract on-demand hourly price per SKU
    prices: dict[str, float] = {}
    for sku, instance_type in sku_to_instance.items():
        offer = terms.get(sku, {})
        for term in offer.values():
            for dim in term.get("priceDimensions", {}).values():
                usd_per_hour = float(dim.get("pricePerUnit", {}).get("USD", 0))
                if usd_per_hour > 0:
                    monthly = round(usd_per_hour * 730, 2)
                    # Keep the lowest price if duplicates exist
                    if instance_type not in prices or monthly < prices[instance_type]:
                        prices[instance_type] = monthly

    logger.info(f"Loaded {len(prices)} instance prices for {region}")
    return prices


def _get_region_prices(region: str) -> dict[str, float]:
    """Return cached prices for a region, fetching if not yet loaded."""
    with _cache_lock:
        if region not in _price_cache:
            try:
                _price_cache[region] = _fetch_region_prices(region)
            except Exception as e:
                logger.error(f"Failed to fetch pricing for {region}: {e}")
                _price_cache[region] = {}
        return _price_cache[region]


def get_instance_on_demand_price(instance_type: str, region: str = "us-east-1") -> float | None:
    """
    Return monthly on-demand price (USD) for an EC2 instance type in a region.
    Monthly = hourly_rate * 730 hours.
    Returns None if price is unavailable.
    No AWS credentials required.
    """
    prices = _get_region_prices(region)
    return prices.get(instance_type)


def get_prices_for_instances(
    instance_types: list[str],
    region: str = "us-east-1",
) -> dict[str, float]:
    """
    Return on-demand prices for a list of instance types.
    Returns {instance_type: monthly_usd}. Missing entries mean price unavailable.
    """
    prices = _get_region_prices(region)
    return {itype: prices[itype] for itype in instance_types if itype in prices}
