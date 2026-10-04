"""DANGER: drops and recreates the collection (all vectors are lost). Requires --yes."""

import sys

from app.config import Settings
from app.vectorstore import collection_for, connect, ensure_collection

if "--yes" not in sys.argv:
    sys.exit("refusing to drop the collection without --yes")

s = Settings()
name = s.collection or collection_for(s.clip_model)
client = connect(s.weaviate_url, s.weaviate_api_key, s.weaviate_grpc_port)
try:
    client.collections.delete(name)
    ensure_collection(client, name)
    print(f"recreated {name}")
finally:
    client.close()
