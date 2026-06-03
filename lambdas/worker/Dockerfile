FROM public.ecr.aws/lambda/python:3.12

# CPU-only torch + transformers; no CUDA packages
RUN pip install --no-cache-dir \
    torch==2.3.1 --extra-index-url https://download.pytorch.org/whl/cpu \
    transformers==4.41.2 \
    boto3==1.34.144

COPY handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.lambda_handler"]
