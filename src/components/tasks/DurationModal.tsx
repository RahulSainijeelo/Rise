import React, { useState, useEffect } from 'react';
import { View, Modal, TouchableOpacity, ScrollView } from 'react-native';
import { NothingText } from '../NothingText';
import { NothingButton } from '../NothingButton';
import { DurationModalProps } from '../../utils/TaskScreen.utils';
import { DurationModalStyle as styles } from '../../styles/styles';
import { ModalHandle } from './ModalHandle';
import { RotateCcw } from 'lucide-react-native';

export const DurationModal: React.FC<DurationModalProps> = ({
    visible, onClose, theme, insets, duration, setDuration
}) => {
    const [history, setHistory] = useState<number[]>([]);
    const [currentDuration, setCurrentDuration] = useState(duration || 0);

    useEffect(() => {
        if (visible) {
            setCurrentDuration(duration || 0);
            setHistory([]);
        }
    }, [visible, duration]);

    const handleAdd = (mins: number) => {
        setHistory([...history, currentDuration]);
        setCurrentDuration(prev => Math.max(0, prev + mins));
    };

    const handleRevert = () => {
        if (history.length > 0) {
            const last = history[history.length - 1];
            setCurrentDuration(last);
            setHistory(history.slice(0, -1));
        }
    };

    const handleSave = () => {
        setDuration(currentDuration);
        onClose();
    };

    const formatDuration = (mins: number) => {
        if (mins === 0) return 'NO DURATION';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h > 0) return `${h}H ${m > 0 ? `${m}M` : ''}`;
        return `${m} MINUTES`;
    };

    return (
        <Modal
            transparent={true}
            visible={visible}
            animationType="fade"
            onRequestClose={onClose}
            statusBarTranslucent
        >
            <TouchableOpacity
                style={styles.modalOverlay}
                activeOpacity={1}
                onPress={onClose}
            >
                <ModalHandle theme={theme} />
                <View
                    style={[
                        styles.addModalContent,
                        {
                            backgroundColor: theme.colors.surface1,
                            paddingBottom: (insets.bottom || 20) + 24,
                            borderColor: theme.colors.border
                        }
                    ]}
                    onStartShouldSetResponder={() => true}
                >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <NothingText variant="bold" size={28} style={{ fontFamily: 'ndot' }}>DURATION</NothingText>
                        <TouchableOpacity
                            onPress={handleRevert}
                            disabled={history.length === 0}
                            style={{ opacity: history.length === 0 ? 0.3 : 1 }}
                        >
                            <RotateCcw size={24} color={theme.colors.text} />
                        </TouchableOpacity>
                    </View>

                    <NothingText
                        variant="bold"
                        size={32}
                        color={theme.colors.primary}
                        style={{ textAlign: 'center', marginBottom: 24, fontFamily: 'ndot' }}
                    >
                        {formatDuration(currentDuration)}
                    </NothingText>

                    <View style={styles.durationChipContainer}>
                        {[1, 5, 10, 30].map(m => (
                            <TouchableOpacity
                                key={`plus-${m}`}
                                style={styles.durationChip}
                                onPress={() => handleAdd(m)}
                            >
                                <NothingText>+{m}m</NothingText>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            style={styles.durationChip}
                            onPress={() => handleAdd(-60)}
                        >
                            <NothingText>-1h</NothingText>
                        </TouchableOpacity>
                    </View>

                    <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 16, opacity: 0.1 }} />

                    <NothingText size={12} color={theme.colors.textSecondary} style={{ marginBottom: 12 }}>QUICK PRESETS</NothingText>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 24 }}>
                        {[15, 30, 45, 60, 90, 120].map(m => (
                            <TouchableOpacity
                                key={`preset-${m}`}
                                style={[styles.durationChip, { marginRight: 8 }, currentDuration === m && { backgroundColor: theme.colors.primary }]}
                                onPress={() => { setHistory([...history, currentDuration]); setCurrentDuration(m); }}
                            >
                                <NothingText color={currentDuration === m ? theme.colors.background : theme.colors.text}>
                                    {m < 60 ? `${m}m` : `${m / 60}h`}
                                </NothingText>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>

                    <NothingButton
                        label="SET DURATION"
                        onPress={handleSave}
                    />
                </View>
            </TouchableOpacity>
        </Modal>
    );
};

