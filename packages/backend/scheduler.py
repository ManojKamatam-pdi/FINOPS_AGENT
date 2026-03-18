"""
Scheduler stub for local dev — APScheduler is disabled locally.

In local mode (DYNAMODB_ENDPOINT set), there is no scheduled run.
Use the "Run Fresh Analysis" button in the UI to trigger runs on demand.

In AWS, EventBridge + scheduler Lambda handles the nightly trigger externally.
APScheduler is never active in either environment.
"""
import os
import logging

logger = logging.getLogger(__name__)


def start_scheduler() -> None:
    if os.getenv("DYNAMODB_ENDPOINT"):
        logger.info("Local mode — scheduler disabled. Use the UI to trigger runs.")
    else:
        logger.info("AWS mode — scheduler disabled (EventBridge + Lambda handles scheduling).")


def stop_scheduler() -> None:
    pass
