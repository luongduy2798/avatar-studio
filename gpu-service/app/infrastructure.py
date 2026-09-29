from __future__ import annotations

import json
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import boto3

from .config import Settings


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


class JobStore(Protocol):
    def get(self, job_id: str) -> dict[str, Any] | None: ...
    def put(self, job: dict[str, Any]) -> None: ...


class LocalJobStore:
    def __init__(self, runtime_root: Path) -> None:
        self.root = runtime_root / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, job_id: str) -> Path:
        return self.root / f"{job_id}.json"

    def get(self, job_id: str) -> dict[str, Any] | None:
        path = self._path(job_id)
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def put(self, job: dict[str, Any]) -> None:
        _atomic_json_write(self._path(str(job["jobId"])), job)


class DynamoDbJobStore:
    def __init__(self, settings: Settings) -> None:
        if not settings.aws_jobs_table:
            raise RuntimeError("AVATAR_DYNAMODB_JOBS_TABLE is required in aws mode")
        self.table = boto3.resource("dynamodb", region_name=settings.aws_region).Table(
            settings.aws_jobs_table
        )

    def get(self, job_id: str) -> dict[str, Any] | None:
        response = self.table.get_item(Key={"jobId": job_id}, ConsistentRead=True)
        item = response.get("Item")
        if not item:
            return None
        return json.loads(str(item["payload"]))

    def put(self, job: dict[str, Any]) -> None:
        self.table.put_item(
            Item={
                "jobId": str(job["jobId"]),
                "payload": json.dumps(job, ensure_ascii=False),
                "updatedAt": str(job.get("updatedAt", "")),
            }
        )


class Storage(Protocol):
    def materialize_input(self, key: str, destination: Path) -> Path: ...
    def put_output(self, key: str, source: Path) -> None: ...


class LocalStorage:
    def __init__(self, runtime_root: Path) -> None:
        self.root = runtime_root / "storage"
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        candidate = (self.root / key).resolve()
        if self.root.resolve() not in candidate.parents:
            raise ValueError("Storage key escapes the configured root")
        return candidate

    def materialize_input(self, key: str, destination: Path) -> Path:
        source = self._resolve(key)
        if not source.is_file():
            raise FileNotFoundError(f"Input object not found: {key}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        return destination

    def put_output(self, key: str, source: Path) -> None:
        target = self._resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


class S3Storage:
    def __init__(self, settings: Settings) -> None:
        if not settings.aws_bucket:
            raise RuntimeError("AVATAR_S3_BUCKET is required in aws mode")
        self.bucket = settings.aws_bucket
        self.client = boto3.client("s3", region_name=settings.aws_region)

    def materialize_input(self, key: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.client.download_file(self.bucket, key, str(destination))
        return destination

    def put_output(self, key: str, source: Path) -> None:
        self.client.upload_file(str(source), self.bucket, key, ExtraArgs={"ContentType": "image/png"})


@dataclass(frozen=True)
class QueueMessage:
    id: str
    body: dict[str, Any]
    receipt: str
    receive_count: int


class Queue(Protocol):
    def receive(self) -> QueueMessage | None: ...
    def receive_batch(self, max_messages: int, wait_seconds: float) -> list[QueueMessage]: ...
    def ack(self, message: QueueMessage) -> None: ...
    def retry(self, message: QueueMessage) -> None: ...
    def dead_letter(self, message: QueueMessage) -> None: ...
    def heartbeat(self, message: QueueMessage) -> None: ...


class LocalQueue:
    def __init__(self, runtime_root: Path) -> None:
        self.pending = runtime_root / "queue" / "pending"
        self.processing = runtime_root / "queue" / "processing"
        self.dlq = runtime_root / "queue" / "dlq"
        for path in (self.pending, self.processing, self.dlq):
            path.mkdir(parents=True, exist_ok=True)

    def receive(self) -> QueueMessage | None:
        for source in sorted(self.pending.glob("*.json")):
            claimed = self.processing / source.name
            try:
                source.replace(claimed)
            except FileNotFoundError:
                continue
            body = json.loads(claimed.read_text(encoding="utf-8"))
            return QueueMessage(
                id=source.stem,
                body=body,
                receipt=str(claimed),
                receive_count=int(body.get("receiveCount", 1)),
            )
        return None

    def receive_batch(self, max_messages: int, wait_seconds: float) -> list[QueueMessage]:
        limit = max(1, max_messages)
        first = self.receive()
        if first is None:
            return []
        messages = [first]
        deadline = time.monotonic() + max(0.0, wait_seconds)
        while len(messages) < limit:
            message = self.receive()
            if message is not None:
                messages.append(message)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.005, remaining))
        return messages

    def ack(self, message: QueueMessage) -> None:
        Path(message.receipt).unlink(missing_ok=True)

    def retry(self, message: QueueMessage) -> None:
        source = Path(message.receipt)
        if not source.exists():
            return
        body = dict(message.body)
        body["receiveCount"] = message.receive_count + 1
        _atomic_json_write(source, body)
        source.replace(self.pending / source.name)

    def dead_letter(self, message: QueueMessage) -> None:
        source = Path(message.receipt)
        if source.exists():
            source.replace(self.dlq / source.name)

    def heartbeat(self, message: QueueMessage) -> None:
        return


class SqsQueue:
    def __init__(self, settings: Settings) -> None:
        if not settings.aws_queue_url:
            raise RuntimeError("AVATAR_SQS_QUEUE_URL is required in aws mode")
        self.queue_url = settings.aws_queue_url
        self.visibility_timeout = settings.worker_visibility_timeout_seconds
        self.client = boto3.client("sqs", region_name=settings.aws_region)

    def receive(self) -> QueueMessage | None:
        messages = self.receive_batch(1, 0.0)
        return messages[0] if messages else None

    def receive_batch(self, max_messages: int, wait_seconds: float) -> list[QueueMessage]:
        response = self.client.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=min(max(1, max_messages), 10),
            WaitTimeSeconds=20,
            VisibilityTimeout=self.visibility_timeout,
            AttributeNames=["ApproximateReceiveCount"],
        )
        return [
            QueueMessage(
                id=str(raw["MessageId"]),
                body=json.loads(str(raw["Body"])),
                receipt=str(raw["ReceiptHandle"]),
                receive_count=int(raw.get("Attributes", {}).get("ApproximateReceiveCount", "1")),
            )
            for raw in response.get("Messages", [])
        ]

    def ack(self, message: QueueMessage) -> None:
        self.client.delete_message(QueueUrl=self.queue_url, ReceiptHandle=message.receipt)

    def retry(self, message: QueueMessage) -> None:
        return

    def dead_letter(self, message: QueueMessage) -> None:
        return

    def heartbeat(self, message: QueueMessage) -> None:
        self.client.change_message_visibility(
            QueueUrl=self.queue_url,
            ReceiptHandle=message.receipt,
            VisibilityTimeout=self.visibility_timeout,
        )


def build_infrastructure(settings: Settings) -> tuple[JobStore, Storage, Queue]:
    settings.runtime_root.mkdir(parents=True, exist_ok=True)
    if settings.infrastructure_mode == "aws":
        return DynamoDbJobStore(settings), S3Storage(settings), SqsQueue(settings)
    if settings.infrastructure_mode != "local":
        raise RuntimeError(f"Unsupported AVATAR_INFRA_MODE: {settings.infrastructure_mode}")
    return (
        LocalJobStore(settings.runtime_root),
        LocalStorage(settings.runtime_root),
        LocalQueue(settings.runtime_root),
    )
