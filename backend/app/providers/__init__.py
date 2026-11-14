from .base import Provider
from .yahoo import YahooProvider

_provider: Provider = YahooProvider()


def get_provider() -> Provider:
    return _provider
