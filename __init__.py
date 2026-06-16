"""ComfyUI Workflow Vault extension entry point."""

from .workflow_vault import api  # noqa: F401  (registers backend routes)

WEB_DIRECTORY = "web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
