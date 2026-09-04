#include "whisper.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

void quiet_log(ggml_log_level, const char *, void *) {}

std::string base64url_encode(const std::string & input) {
    static constexpr char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string output;
    output.reserve((input.size() * 4 + 2) / 3);
    std::uint32_t value = 0;
    int bits = -6;
    for (const unsigned char byte : input) {
        value = (value << 8U) | byte;
        bits += 8;
        while (bits >= 0) {
            output.push_back(table[(value >> bits) & 0x3FU]);
            bits -= 6;
        }
    }
    if (bits > -6) output.push_back(table[((value << 8U) >> (bits + 8)) & 0x3FU]);
    return output;
}

bool base64url_decode(const std::string & input, std::string & output) {
    static const std::string table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::uint32_t value = 0;
    int bits = -8;
    output.clear();
    for (const unsigned char character : input) {
        const auto position = table.find(static_cast<char>(character));
        if (position == std::string::npos) return false;
        value = (value << 6U) | static_cast<std::uint32_t>(position);
        bits += 6;
        if (bits >= 0) {
            output.push_back(static_cast<char>((value >> bits) & 0xFFU));
            bits -= 8;
        }
    }
    return true;
}

std::string json_escape(const std::string & input) {
    std::ostringstream output;
    for (const unsigned char character : input) {
        switch (character) {
            case '"': output << "\\\""; break;
            case '\\': output << "\\\\"; break;
            case '\b': output << "\\b"; break;
            case '\f': output << "\\f"; break;
            case '\n': output << "\\n"; break;
            case '\r': output << "\\r"; break;
            case '\t': output << "\\t"; break;
            default:
                if (character < 0x20) {
                    static constexpr char hex[] = "0123456789abcdef";
                    output << "\\u00" << hex[(character >> 4U) & 0xFU] << hex[character & 0xFU];
                } else {
                    output << static_cast<char>(character);
                }
        }
    }
    return output.str();
}

std::uint16_t read_u16(const unsigned char * value) {
    return static_cast<std::uint16_t>(value[0]) | (static_cast<std::uint16_t>(value[1]) << 8U);
}

std::uint32_t read_u32(const unsigned char * value) {
    return static_cast<std::uint32_t>(value[0]) |
           (static_cast<std::uint32_t>(value[1]) << 8U) |
           (static_cast<std::uint32_t>(value[2]) << 16U) |
           (static_cast<std::uint32_t>(value[3]) << 24U);
}

bool load_wav(const std::string & path, std::vector<float> & samples, std::string & error) {
    std::ifstream file(path, std::ios::binary);
    if (!file) { error = "Cannot open the temporary WAV input."; return false; }
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) != 0 || std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
        error = "The temporary input is not a WAV file."; return false;
    }
    bool valid_format = false;
    const unsigned char * pcm = nullptr;
    std::size_t pcm_size = 0;
    std::size_t offset = 12;
    while (offset + 8 <= bytes.size()) {
        const auto size = static_cast<std::size_t>(read_u32(bytes.data() + offset + 4));
        const auto start = offset + 8;
        if (start + size > bytes.size()) { error = "A WAV chunk length is invalid."; return false; }
        if (std::memcmp(bytes.data() + offset, "fmt ", 4) == 0 && size >= 16) {
            valid_format = read_u16(bytes.data() + start) == 1 &&
                           read_u16(bytes.data() + start + 2) == 1 &&
                           read_u32(bytes.data() + start + 4) == 16000 &&
                           read_u16(bytes.data() + start + 14) == 16;
        } else if (std::memcmp(bytes.data() + offset, "data", 4) == 0) {
            pcm = bytes.data() + start;
            pcm_size = size;
        }
        offset = start + size + (size % 2U);
    }
    if (!valid_format || pcm == nullptr || pcm_size == 0 || pcm_size % 2U != 0) {
        error = "WAV must be PCM16 little-endian, 16 kHz, mono."; return false;
    }
    samples.resize(pcm_size / 2U);
    for (std::size_t index = 0; index < samples.size(); ++index) {
        const auto raw = static_cast<std::int16_t>(read_u16(pcm + index * 2U));
        samples[index] = static_cast<float>(raw) / 32768.0F;
    }
    std::fill(bytes.begin(), bytes.end(), static_cast<unsigned char>(0));
    return true;
}

void write_error(const std::string & id, const std::string & code, const std::string & message) {
    std::cout << "ERROR " << id << ' ' << code << ' ' << base64url_encode(message) << '\n' << std::flush;
}

std::string basename(const std::string & path) {
    const auto position = path.find_last_of("/\\");
    return position == std::string::npos ? path : path.substr(position + 1);
}

} // namespace

int main(int argc, char ** argv) {
    std::string model_path;
    for (int index = 1; index < argc; ++index) {
        if (std::string(argv[index]) == "--model" && index + 1 < argc) model_path = argv[++index];
    }
    if (model_path.empty()) {
        std::cerr << "A model path is required.\n";
        return 2;
    }

    whisper_log_set(quiet_log, nullptr);
    auto context_parameters = whisper_context_default_params();
    context_parameters.use_gpu = false;
    whisper_context * context = whisper_init_from_file_with_params_no_state(model_path.c_str(), context_parameters);
    if (context == nullptr) {
        std::cerr << "The Whisper model could not be loaded.\n";
        return 3;
    }

    const std::string ready = "{\"protocolVersion\":\"1.0.0\",\"model\":\"" + json_escape(basename(model_path)) + "\",\"language\":\"en\"}";
    std::cout << "READY " << base64url_encode(ready) << '\n' << std::flush;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "QUIT") break;
        std::istringstream command(line);
        std::string operation;
        std::string id;
        std::string encoded_path;
        std::string unexpected;
        command >> operation >> id >> encoded_path >> unexpected;
        if (operation != "TRANSCRIBE" || id.empty() || encoded_path.empty() || !unexpected.empty()) {
            write_error(id.empty() ? "unknown" : id, "INVALID_REQUEST", "The worker command is malformed.");
            continue;
        }
        std::string wav_path;
        if (!base64url_decode(encoded_path, wav_path)) {
            write_error(id, "INVALID_REQUEST", "The worker path encoding is malformed.");
            continue;
        }
        std::vector<float> samples;
        std::string audio_error;
        if (!load_wav(wav_path, samples, audio_error)) {
            write_error(id, "INVALID_AUDIO", audio_error);
            continue;
        }

        auto parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        parameters.n_threads = std::max(1, std::min(8, static_cast<int>(std::thread::hardware_concurrency())));
        parameters.language = "en";
        parameters.detect_language = false;
        parameters.translate = false;
        parameters.no_context = true;
        parameters.no_timestamps = false;
        parameters.single_segment = false;
        parameters.print_special = false;
        parameters.print_progress = false;
        parameters.print_realtime = false;
        parameters.print_timestamps = false;
        parameters.initial_prompt = nullptr;
        parameters.prompt_tokens = nullptr;
        parameters.prompt_n_tokens = 0;

        whisper_state * state = whisper_init_state(context);
        if (state == nullptr) {
            std::fill(samples.begin(), samples.end(), 0.0F);
            write_error(id, "WORKER_FAILURE", "A fresh Whisper inference state could not be created.");
            continue;
        }
        if (whisper_full_with_state(context, state, parameters, samples.data(), static_cast<int>(samples.size())) != 0) {
            std::fill(samples.begin(), samples.end(), 0.0F);
            whisper_free_state(state);
            write_error(id, "WORKER_FAILURE", "Whisper inference failed.");
            continue;
        }

        std::ostringstream json;
        std::string full_text;
        json << "{\"text\":\"";
        const int segment_count = whisper_full_n_segments_from_state(state);
        for (int segment = 0; segment < segment_count; ++segment) full_text += whisper_full_get_segment_text_from_state(state, segment);
        json << json_escape(full_text) << "\",\"segments\":[";
        for (int segment = 0; segment < segment_count; ++segment) {
            if (segment > 0) json << ',';
            json << "{\"startMs\":" << whisper_full_get_segment_t0_from_state(state, segment) * 10
                 << ",\"endMs\":" << whisper_full_get_segment_t1_from_state(state, segment) * 10
                 << ",\"text\":\"" << json_escape(whisper_full_get_segment_text_from_state(state, segment)) << "\"}";
        }
        json << "]}";
        std::fill(samples.begin(), samples.end(), 0.0F);
        whisper_free_state(state);
        std::cout << "RESULT " << id << ' ' << base64url_encode(json.str()) << '\n' << std::flush;
    }

    whisper_free(context);
    return 0;
}
