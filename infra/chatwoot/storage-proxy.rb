# Mounted into Chatwoot's config/initializers (docker-compose.yml, support profile).
# Attachment links go through Chatwoot (/rails/active_storage/blobs/proxy/...) instead of
# redirecting the browser to a presigned S3 URL, so the bucket stays private and its endpoint
# (http://s3:8333 locally) does not have to be reachable from browsers.
Rails.application.config.active_storage.resolve_model_to_route = :rails_storage_proxy
