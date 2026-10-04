"""Create the Weaviate collection if missing (the service also does this on startup)."""

from app.config import Settings
from app.vectorstore import collection_for, connect, ensure_collection

s = Settings()
name = s.collection or collection_for(s.clip_model)
client = connect(s.weaviate_url, s.weaviate_api_key, s.weaviate_grpc_port)
try:
    ensure_collection(client, name)
    print("collections:", list(client.collections.list_all().keys()))
finally:
    client.close()
