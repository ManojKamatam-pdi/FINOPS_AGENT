"""
AWS Pricing Calculator URL builder.
Links to the AWS Pricing Calculator with the suggested instance pre-selected.
The calculator does not support full deep-links with pre-filled comparisons,
so we link to the EC2 service page and surface the cost numbers in the UI.
"""


def build_pricing_calculator_url(
    current_instance: str,
    suggested_instance: str,
    region: str = "us-east-1",
) -> str:
    """
    Return a link to the AWS Pricing Calculator EC2 page.
    The UI displays the actual cost numbers (current vs suggested) alongside this link.
    """
    # The calculator uses hash-based routing with no documented deep-link format.
    # Link to the EC2 calculator page — users can verify the numbers shown in the dashboard.
    return "https://calculator.aws/#/addService/EC2"
