FROM python:3.13-alpine
WORKDIR /app
COPY services/reconciler/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/reconciler/reconcile.py .
CMD ["python", "reconcile.py"]
