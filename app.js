require("dotenv").config();

class LangflowClient {
    constructor(baseURL, applicationToken) {
        if (!baseURL || !applicationToken) {
            throw new Error('baseURL and applicationToken are required');
        }
        this.baseURL = baseURL;
        this.applicationToken = applicationToken;
        this.headers = {
            "Authorization": `Bearer ${this.applicationToken}`,
            "Content-Type": "application/json"
        };
    }

    async post(endpoint, body) {
        const url = `${this.baseURL}${endpoint}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(body),
                timeout: 30000 // 30 second timeout
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`HTTP ${response.status}: ${errorData.message || response.statusText}`);
            }

            return response.json();
        } catch (error) {
            throw new Error(`Request failed: ${error.message}`);
        }
    }

    async initiateSession(flowId, langflowId, inputValue, inputType = 'chat', outputType = 'chat', stream = false, tweaks = {}) {
        if (!flowId || !langflowId || !inputValue) {
            throw new Error('Missing required parameters');
        }
        const endpoint = `/lf/${langflowId}/api/v1/run/${flowId}?stream=${stream}`;
        return this.post(endpoint, { 
            input_value: inputValue, 
            input_type: inputType, 
            output_type: outputType, 
            tweaks: tweaks 
        });
    }

    handleStream(streamUrl, onUpdate, onClose, onError) {
        if (!streamUrl) {
            throw new Error('Stream URL is required');
        }

        const eventSource = new EventSource(streamUrl);
        let heartbeatTimeout;

        const resetHeartbeat = () => {
            if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
            heartbeatTimeout = setTimeout(() => {
                console.warn('Stream timeout - no data received');
                eventSource.close();
                onError(new Error('Stream timeout'));
            }, 30000); // 30 second timeout
        };

        eventSource.onmessage = event => {
            resetHeartbeat();
            try {
                const data = JSON.parse(event.data);
                onUpdate(data);
            } catch (error) {
                onError(new Error(`Failed to parse stream data: ${error.message}`));
                eventSource.close();
            }
        };

        eventSource.onerror = event => {
            clearTimeout(heartbeatTimeout);
            onError(event);
            eventSource.close();
        };

        eventSource.addEventListener("close", () => {
            clearTimeout(heartbeatTimeout);
            onClose('Stream closed');
            eventSource.close();
        });

        resetHeartbeat();
        return eventSource;
    }

    async runFlow(flowIdOrName, langflowId, inputValue, inputType = 'chat', outputType = 'chat', tweaks = {}, stream = false, onUpdate, onClose, onError) {
        try {
            const initResponse = await this.initiateSession(
                flowIdOrName, 
                langflowId, 
                inputValue, 
                inputType, 
                outputType, 
                stream, 
                tweaks
            );

            if (stream && initResponse?.outputs?.[0]?.outputs?.[0]?.artifacts?.stream_url) {
                const streamUrl = initResponse.outputs[0].outputs[0].artifacts.stream_url;
                return this.handleStream(streamUrl, onUpdate, onClose, onError);
            }

            return initResponse;
        } catch (error) {
            throw new Error(`Flow execution failed: ${error.message}`);
        }
    }
}

// Cache implementation for insights
const NodeCache = require('node-cache');
const insightsCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

async function getInsights(inputValue, inputType = 'chat', outputType = 'chat', stream = false) {
    // Check cache first
    const cacheKey = `insights-${inputValue}`;
    const cachedResult = insightsCache.get(cacheKey);
    if (cachedResult) {
        return cachedResult;
    }

    const flowIdOrName = '5d664ca6-224d-4112-b143-d31786f9a046';
    const langflowId = 'aa552875-56d4-431d-94bd-389aa1c8d68f';
    const applicationToken = process.env.MODEL_TOKEN;

    if (!applicationToken) {
        throw new Error('MODEL_TOKEN environment variable is not set');
    }

    const langflowClient = new LangflowClient(
        'https://api.langflow.astra.datastax.com',
        applicationToken
    );

    try {
        const tweaks = {
            "Agent-C6mqP": {},
            "ChatInput-X4siD": {},
            "ChatOutput-XzlpZ": {},
            "URL-DITVH": {},
            "AstraDBCQLToolComponent-GXZ2B": {}
        };

        const response = await langflowClient.runFlow(
            flowIdOrName,
            langflowId,
            inputValue,
            inputType,
            outputType,
            tweaks,
            stream,
            (data) => console.log("Received:", data.chunk),
            (message) => console.log("Stream Closed:", message),
            (error) => console.error("Stream Error:", error)
        );

        if (!stream && response?.outputs?.[0]?.outputs?.[0]?.outputs?.message?.message?.text) {
            const output = response.outputs[0].outputs[0].outputs.message.message.text;
            // Cache the result
            insightsCache.set(cacheKey, output);
            return output;
        }

        throw new Error('Invalid response format');
    } catch (error) {
        throw new Error(`Failed to get insights: ${error.message}`);
    }
}

const fastify = require('fastify')({ 
    logger: {
        level: 'info',
        serializers: {
            req(request) {
                return {
                    method: request.method,
                    url: request.url,
                    headers: request.headers
                };
            }
        }
    }
});

// Register plugins with options
fastify.register(require('@fastify/cors'), {
    origin: true, // Configure this based on your needs
    methods: ['GET', 'POST'],
    maxAge: 86400 // 24 hours
});

fastify.register(require('@fastify/sensible'));
fastify.register(require('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute'
});

// Health check route with detailed status
fastify.get('/health', async () => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    };
});

// Insights route with proper error handling
fastify.get('/insights/:keyword', {
    schema: {
        params: {
            type: 'object',
            required: ['keyword'],
            properties: {
                keyword: { type: 'string', minLength: 1 }
            }
        }
    }
}, async (request, reply) => {
    try {
        const { keyword } = request.params;
        const response = await getInsights(keyword);
        return { success: true, data: response };
    } catch (error) {
        request.log.error(error);
        throw fastify.httpErrors.createError(500, error.message);
    }
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    
    // Don't expose internal errors to clients
    const statusCode = error.statusCode || 500;
    const response = {
        success: false,
        error: statusCode === 500 ? 'Internal Server Error' : error.message
    };
    
    reply.status(statusCode).send(response);
});

// Graceful shutdown
const closeGracefully = async (signal) => {
    console.log(`Received signal ${signal}, closing server...`);
    await fastify.close();
    process.exit(0);
};

process.on('SIGTERM', () => closeGracefully('SIGTERM'));
process.on('SIGINT', () => closeGracefully('SIGINT'));

// Start server with proper error handling
const start = async () => {
    try {
        const port = process.env.PORT || 3000;
        const host = process.env.HOST || '0.0.0.0';
        
        await fastify.listen({ port, host });
        console.log(`Server listening on ${host}:${port}`);
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

start();