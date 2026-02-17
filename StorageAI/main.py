"""Application entrypoint for StorageAI.

Launches the PyQt5 GUI for managing API keys and inventory controls.
"""

from src.ui.main_window import launch_app


if __name__ == '__main__':
    launch_app()
