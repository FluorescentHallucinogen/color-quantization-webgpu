import { setupBuildHistogram } from './pipelines/buildHistogram.js';
import { setupComputeMoments } from './pipelines/computeMoments.js';
import { setupCreateBox } from './pipelines/createBox.js';
import { setupCreateResult } from './pipelines/createResult.js';
import { floatArrayToHex } from '../utils/color_utils.js';

export async function extractDominantColorsWuGPU(device, source, K) {
    const WORKGROUP_SIZE = 16;

    const width = source.width;
    const height = source.height;
    
    const TOTAL_SIZE = 35937;
    const {
        weightsBuffer,
        momentsRBuffer,
        momentsGBuffer,
        momentsBBuffer,
        momentsBuffer: mBuffer,
        buildHistogramPipeline,
        inputBindGroup,
        buildHistogramBindGroup,
        buildHistogramBindGroupLayout
    } = await setupBuildHistogram(device, source);

    const {
        axisUniformBuffer,
        computeMomentsAxisBindGroup,
        computeMomentsPipeline
    } = await setupComputeMoments(device, buildHistogramBindGroupLayout);

    const {
        momentsBuffer,
        momentsBindGroup,
        totalCubesNumUniformBuffer,
        momentsBindGroupLayout,
        cubesBuffer,
        cubesBindGroup,
        cutBindGroup,
        createBoxPipeline
    } = await setupCreateBox(device, K);

    const {
        resultsBuffer,
        cubesResultBindGroup,
        resultsBindGroup,
        createResultPipeline
    } = await setupCreateResult(device, K, momentsBindGroupLayout, cubesBuffer, totalCubesNumUniformBuffer);

    let encoder = device.createCommandEncoder();
    const buildHistogramPass = encoder.beginComputePass();
    buildHistogramPass.setPipeline(buildHistogramPipeline);
    buildHistogramPass.setBindGroup(0, inputBindGroup);
    buildHistogramPass.setBindGroup(1, buildHistogramBindGroup);
    buildHistogramPass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    buildHistogramPass.end();
    device.queue.submit([encoder.finish()]);

    const workGroupsPerDim = Math.ceil(32 / WORKGROUP_SIZE);
    for (let axis = 0; axis < 3; axis++) {
        encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(computeMomentsPipeline);
        device.queue.writeBuffer(axisUniformBuffer, 0, new Uint32Array([axis]));
        pass.setBindGroup(0, buildHistogramBindGroup);
        pass.setBindGroup(1, computeMomentsAxisBindGroup);
        pass.dispatchWorkgroups(workGroupsPerDim, workGroupsPerDim);
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(
        momentsRBuffer, 0,
        momentsBuffer, 0,
        TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT
    );
    encoder.copyBufferToBuffer(
        momentsGBuffer, 0,
        momentsBuffer, TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT,
        TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT
    );
    encoder.copyBufferToBuffer(
        momentsBBuffer, 0,
        momentsBuffer, 2 * TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT,
        TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT
    );
    encoder.copyBufferToBuffer(
        weightsBuffer, 0,
        momentsBuffer, 3 * TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT,
        TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT
    );
    encoder.copyBufferToBuffer(
        mBuffer, 0,
        momentsBuffer, 4 * TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT,
        TOTAL_SIZE * Uint32Array.BYTES_PER_ELEMENT
    );
    device.queue.submit([encoder.finish()]);

    for (let i = 1; i < K; i++) {
        encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(createBoxPipeline);
        device.queue.writeBuffer(totalCubesNumUniformBuffer, 0, new Uint32Array([i]));

        pass.setBindGroup(0, momentsBindGroup);
        pass.setBindGroup(1, cubesBindGroup);
        pass.setBindGroup(2, cutBindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(createResultPipeline);
    pass.setBindGroup(0, momentsBindGroup);
    pass.setBindGroup(1, cubesResultBindGroup);
    pass.setBindGroup(2, resultsBindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return resultsBuffer;
}

export async function extractDominantColorsWu(imageSource, K) {
    const adapter = await navigator.gpu?.requestAdapter();
    const device = await adapter?.requestDevice();
    if (!device) {
        window.alert('WebGPU not supported');
        throw new Error('WebGPU not supported');
    }

    const source = await createImageBitmap(imageSource, { colorSpaceConversion: 'none' });
    const resultsBuffer = await extractDominantColorsWuGPU(device, source, K);
    
    const stagingResultsBuffer = device.createBuffer({
        size: 3 * K * Uint32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(
        resultsBuffer, 0,
        stagingResultsBuffer, 0,
        3 * K * Uint32Array.BYTES_PER_ELEMENT
    );
    device.queue.submit([encoder.finish()]);

    await stagingResultsBuffer.mapAsync(GPUMapMode.READ, 0, 3 * K * Uint32Array.BYTES_PER_ELEMENT);
    const mappedData = stagingResultsBuffer.getMappedRange();
    const results = new Uint32Array(mappedData.slice(0));
    stagingResultsBuffer.unmap();

    return floatArrayToHex(Float32Array.from(results).map(x => x / 255));
}
