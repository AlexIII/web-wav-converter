
const dragAndDropArea = document.querySelector('.drag-and-drop-area') as HTMLDivElement;
const fileInputElem = document.querySelector('#file-input') as HTMLInputElement;
const fileTableBodyElem = document.querySelector('#file-table-body') as HTMLElement;
const saveButton = document.querySelector('#save-button') as HTMLInputElement;
const sampleRateInput = document.querySelector('#wav-sample-rate') as HTMLInputElement;
const bitDepthInput = document.querySelector('#wav-bit-depth') as HTMLInputElement;
const channelsInput = document.querySelector('#wav-channels') as HTMLInputElement;

const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
if(!isFirefox) document.querySelectorAll('.fx-notice').forEach(el => (el as HTMLInputElement).style.display = "block");

const initDragAndDropArea = (elem: HTMLDivElement, highlightClassName: string, ondrop: (files: File[]) => void) => {
    elem.ondrop = (ev: DragEvent) => {
        elem.classList.remove(highlightClassName);
        ev.preventDefault();
        if (ev.dataTransfer?.items) {
            const files = Array.from(ev.dataTransfer.items)
                .filter(it => it.kind === 'file')
                .map(it => it.getAsFile()!);
            if(files.length) ondrop(files);
        } else if(ev.dataTransfer?.files) {
            const files = Array.from(ev.dataTransfer?.files);
            if(files.length) ondrop(files);
        }
    };
    elem.ondragover = ev => { ev.preventDefault(); };
    elem.ondragenter = () => elem.classList.add(highlightClassName);
    elem.ondragleave = () => elem.classList.remove(highlightClassName);
};

const initOpenFiles = (onopen: (files: File[]) => void) => {
    initDragAndDropArea(dragAndDropArea, 'drag-and-drop-area-highlight', onopen);
    fileInputElem.onchange = () => {
        if(fileInputElem.files) {
            onopen(Array.from(fileInputElem.files));
            fileInputElem.value = '';
        }
    };
};


const makeFileTableRows = (files: File[], playing: number | null, stats: {duration: number; inSize: number; outSize: number;}[]): string => 
    files
        .map((f, idx) => `<tr> 
                <td>${idx+1}</td> 
                <td>${f.name}</td> 
                <td>${Math.round(stats[idx].duration/60)}:${Math.round((stats[idx].duration)%60)}</td> 
                <td>${(stats[idx].inSize/1024/1024).toFixed(1)}Mbyte -> ${(stats[idx].outSize/1024/1024).toFixed(1)}Mbyte</td> 
                <td onclick="removeFileButtonHandler(${idx});"></td> 
                <td onclick="playPauseButtonHandler(${idx});">${idx !== playing? "&#x23F5" : "&#x23F8"}</td> 
            </tr>`)
        .join('\n');

class AudioFilesProcessor {
    private files: File[] = [];
    private playing: number | null = null;
    private stopPlaying: (() => void) | null = null;

    add(files: File[]) {
        //do not add files with the same name twice
        this.files.push(...files.filter(f => !this.files.map(f => f.name).includes(f.name)));
        this.files.sort((a, b) => a.name.localeCompare(b.name));
        this.updateUI();
        (globalThis as any)['removeFileButtonHandler'] = this.remove.bind(this);
        (globalThis as any)['playPauseButtonHandler'] = this.playPause.bind(this);
        saveButton.onclick = () => {
            this.files.forEach(f => this.convertFile(f));
        };
        sampleRateInput.onchange = bitDepthInput.onchange = channelsInput.onchange = () => this.updateUI();
    }
    remove(index: number) {
        if(this.playing !== null) this.playPause(this.playing, false);
        this.files.splice(index, 1);
        this.statsCache.splice(index, 1);
        this.updateUI(false);
    }
    playPause(index: number, updateUI = true) {
        if(this.playing === index) {
            if(this.stopPlaying) {
                this.stopPlaying();
                this.stopPlaying = null;
                this.playing = null;
            }
        } else {
            if(this.playing !== null) this.playPause(this.playing, false);
            this.playing = index;
            this.playFile(this.files[index]);   
        }
        if(updateUI) this.updateUI(false);
    }

    private async playFile(file: File) {
        const targetOptions = this.getTargetOptions();

        const audioCtx = new AudioContext();
        const audioBuffer = await processAudioFile(audioCtx, file, targetOptions.channelOpt, targetOptions.sampleRate);
        const song = audioCtx.createBufferSource();
        song.buffer = audioBuffer;              
        song.connect(audioCtx.destination);
        song.start();
        this.stopPlaying = () => song.stop();
        song.onended = () => this.playing !== null && this.playPause(this.playing);
    }

    private async convertFile(file: File) {
        const targetOptions = this.getTargetOptions();
        const audioCtx = new AudioContext();
        const audioBuffer = await processAudioFile(audioCtx, file, targetOptions.channelOpt, targetOptions.sampleRate);
        const rawData = audioToRawWave(
            targetOptions.channelOpt === 'both'? [audioBuffer.getChannelData(0), audioBuffer.getChannelData(1)] : [audioBuffer.getChannelData(0)],
            targetOptions.bytesPerSample
        );
        const blob = makeWav(rawData, targetOptions.channelOpt === 'both'? 2 : 1, targetOptions.sampleRate, targetOptions.bytesPerSample);

        saveAs(blob, file.name.replace(/(\..+)$/, '.wav'));
    }

    private statsCache: {duration: number; inSize: number; outSize: number;}[] = [];
    private async updateUI(updateStats = true) {
        if(updateStats) this.statsCache = await this.getStats();
        fileTableBodyElem.innerHTML = makeFileTableRows(this.files, this.playing, this.statsCache);
        saveButton.disabled = !this.files.length;
    }

    private async getStats() : Promise<{
        duration: number;
        inSize: number;
        outSize: number;
    }[]> {
        const targetOptions = this.getTargetOptions();
        const audioCtx = new AudioContext();
        const decoded: Array<[AudioBuffer, number]> = await Promise.all(this.files.map(async(f) => [await audioCtx.decodeAudioData(await f.arrayBuffer()), f.size])) as any;
        return decoded.map(([f, inSize]) => ({
            duration: f.duration,
            inSize,
            outSize: (f.length / f.sampleRate) * targetOptions.sampleRate * targetOptions.bytesPerSample * (targetOptions.channelOpt === 'both'? 2 : 1)
        }));
    }

    private getTargetOptions() {
        return {
            sampleRate: Math.round(Number(sampleRateInput.value)),
            bytesPerSample: (Math.round(Number(bitDepthInput.value)) === 8? 1 : 2) as 1 | 2,
            channelOpt: channelsInput.value as 'both' | 'left' | 'right' | 'mix'
        };
    }
}

const audioFilesProcessor = new AudioFilesProcessor();

initOpenFiles(files => {
    const audioFiles = files.filter(f => f.type.startsWith('audio/'));
    if(!audioFiles.length) return;
    audioFilesProcessor.add(audioFiles);
});

const saveAs = (blob: Blob, fileName: string) => {
    var a = document.createElement("a");
    document.body.appendChild(a);
    a.style.display = "none";
    const url = window.URL.createObjectURL(blob);
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
};

/* --- Audio processing --- */

const audioResample = (buffer: AudioBuffer, sampleRate: number): Promise<AudioBuffer> => {
    const offlineCtx = new OfflineAudioContext(2, (buffer.length / buffer.sampleRate) * sampleRate, sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start();
    return offlineCtx.startRendering();
};

const audioReduceChannels = (buffer: AudioBuffer, targetChannelOpt: 'both' | 'left' | 'right' | 'mix'): AudioBuffer => {
    if(targetChannelOpt === 'both') return buffer;
    const outBuffer = new AudioBuffer({
        sampleRate: buffer.sampleRate, 
        length: buffer.length, 
        numberOfChannels: 1
    });

    const data = [buffer.getChannelData(0), buffer.getChannelData(1)];
    const newData = new Float32Array(buffer.length);
    for(let i = 0; i < buffer.length; ++i)
        newData[i] = 
            targetChannelOpt === 'left'? data[0][i] :
            targetChannelOpt === 'right'? data[1][i] :
            (data[0][i] + data[1][i]) / 2 ;
    outBuffer.copyToChannel(newData, 0);
    return outBuffer;
};

const processAudioFile = async (audioCtx: AudioContext, file: File, targetChannelOpt: 'both' | 'left' | 'right' | 'mix', targetSampleRate: number): Promise<AudioBuffer> => {
    const dataFileStraem = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(dataFileStraem);
    const resampled = await audioResample(decoded, targetSampleRate);
    const audioBuffer = audioReduceChannels(resampled, targetChannelOpt);
    return audioBuffer;
}

const audioToRawWave = (audioChannels: Float32Array[], bytesPerSample: 1 | 2, mixChannels = false): Uint8Array => {
    const bufferLength = audioChannels[0].length;
    const numberOfChannels = audioChannels.length === 1? 1 : 2;
    const reducedData = new Uint8Array(bufferLength * numberOfChannels * bytesPerSample);
    for (let i = 0; i < bufferLength; ++i) {
        for (let channel = 0; channel < (mixChannels? 1 : numberOfChannels); ++channel) {
            const outputIndex = (i*numberOfChannels + channel) * bytesPerSample;
            let sample: number;
            if(!mixChannels) sample = audioChannels[channel][i];
            else sample = audioChannels.reduce((prv, cur) => prv + cur[i], 0) / numberOfChannels;
            sample = sample > 1? 1 : sample < -1? -1 : sample; //check for clipping
            //bit reduce and convert to Uint8
            switch(bytesPerSample) {
                case 2:
                    sample = sample * 32767;
                    reducedData[outputIndex] = sample;
                    reducedData[outputIndex + 1] = sample >> 8;
                    break;
                case 1:
                    reducedData[outputIndex] = (sample + 1) * 127;
                    break;
                default: 
                    throw "Only 8, 16 bits per sample are supported";
            }
        }
    }
    return reducedData;
};

const makeWav = (data: Uint8Array, channels: 1 | 2, sampleRate: number, bytesPerSample: 1 | 2): Blob => {
    const headerLength = 44;
    var wav = new Uint8Array(headerLength + data.length);
    var view = new DataView(wav.buffer);
  
    view.setUint32( 0, 1380533830, false ); // RIFF identifier 'RIFF'
    view.setUint32( 4, 36 + data.length, true ); // file length minus RIFF identifier length and file description length
    view.setUint32( 8, 1463899717, false ); // RIFF type 'WAVE'
    view.setUint32( 12, 1718449184, false ); // format chunk identifier 'fmt '
    view.setUint32( 16, 16, true ); // format chunk length
    view.setUint16( 20, 1, true ); // sample format (raw)
    view.setUint16( 22, channels, true ); // channel count
    view.setUint32( 24, sampleRate, true ); // sample rate
    view.setUint32( 28, sampleRate * bytesPerSample * channels, true ); // byte rate (sample rate * block align)
    view.setUint16( 32, bytesPerSample * channels, true ); // block align (channel count * bytes per sample)
    view.setUint16( 34, bytesPerSample * 8, true ); // bits per sample
    view.setUint32( 36, 1684108385, false); // data chunk identifier 'data'
    view.setUint32( 40, data.length, true ); // data chunk length
  
    wav.set(data, headerLength);
  
    return new Blob([wav.buffer], {type:"audio/wav"});
};

/* --- --- */